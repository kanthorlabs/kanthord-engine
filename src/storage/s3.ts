import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import {
  PRESIGN_LIFETIME_S,
  ResultClass,
  type ResultClassValue,
} from "../intake/contract.ts";
import { HttpStatus } from "../kernel/http.ts";
import { thrownReason } from "../kernel/probe.ts";
import { isObject, isString } from "../kernel/values.ts";

export const S3_RESULT_CODE_PREFIX = "storage.platform.s3.";
export const READ_RETRY_DELAY_MS = 250;
export const READ_ATTEMPT_LIMIT = 240;
export const CONTENT_LENGTH_HEADER = "content-length";
export const CHECKSUM_SHA256_HEADER = "x-amz-checksum-sha256";
const MS_PER_S = 1000;
const NO_TIME_LEFT_MS = 0;
const MIN_SECRET_LENGTH = 1;
const MIN_KEY_LENGTH = 1;
const MIN_OBJECT_SIZE = 0;
const CAUSE_DEPTH_LIMIT = 4;
const SLOW_DOWN = "SlowDown";
const CHECKSUM_TYPE_COMPOSITE = "COMPOSITE";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const BEFORE_DISPATCH_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export const S3CallKind = {
  Read: "read",
  Write: "write",
} as const;
export type S3CallKind = (typeof S3CallKind)[keyof typeof S3CallKind];

const DispatchPhase = {
  BeforeDispatch: "before_dispatch",
  AfterDispatch: "after_dispatch",
} as const;
type DispatchPhase = (typeof DispatchPhase)[keyof typeof DispatchPhase];

export interface S3Call {
  accessKeyId: string;
  secretAccessKey: string;
  signal: AbortSignal;
  deadlineAt: number;
}

export interface S3Location {
  endpoint: string;
  bucket: string;
  region: string;
}

export interface S3PutTarget extends S3Location {
  key: string;
  size: number;
  sha256: string | null;
}

export interface S3ObjectTarget extends S3Location {
  key: string;
  version: string | null;
}

export interface S3Failure {
  ok: false;
  class: ResultClassValue;
  code: string;
  status: number | null;
  message: string;
}

export type S3Answer<T> = { ok: true; value: T } | S3Failure;

export interface PresignedPut {
  put_url: string;
  headers: Record<string, string>;
  expires_at: number;
}

export interface PresignedGet {
  get_url: string;
  expires_at: number;
}

export interface ObjectHead {
  size: number;
  sha256: string | null;
  version: string | null;
}

type Attempt<T> =
  { ok: true; value: T } | { ok: false; error: unknown; phase: DispatchPhase };

type Send<T> = (client: S3Client, abortSignal: AbortSignal) => Promise<T>;

const headAnswerSchema = z.object({
  ContentLength: z.number().int().nonnegative(),
  ChecksumSHA256: z.string().regex(SHA256_BASE64_PATTERN).optional(),
  ChecksumType: z.string().optional(),
  VersionId: z.string().min(MIN_KEY_LENGTH).optional(),
});

const deleteAnswerSchema = z.object({
  VersionId: z.string().min(MIN_KEY_LENGTH).optional(),
});

function assertCall(call: S3Call): void {
  assert.ok(call.accessKeyId.length >= MIN_SECRET_LENGTH);
  assert.ok(call.secretAccessKey.length >= MIN_SECRET_LENGTH);
  assert.ok(Number.isFinite(call.deadlineAt));
}

function clientOf(call: S3Call, location: S3Location): S3Client {
  assertCall(call);
  assert.ok(location.bucket.length >= MIN_KEY_LENGTH);
  return new S3Client({
    endpoint: location.endpoint,
    region: location.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: call.accessKeyId,
      secretAccessKey: call.secretAccessKey,
    },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}

function base64OfHex(sha256: string): string {
  assert.match(sha256, SHA256_HEX_PATTERN);
  const encoded = Buffer.from(sha256, "hex").toString("base64");
  assert.match(encoded, SHA256_BASE64_PATTERN);
  return encoded;
}

function hexOfBase64(checksum: string): string {
  assert.match(checksum, SHA256_BASE64_PATTERN);
  const decoded = Buffer.from(checksum, "base64").toString("hex");
  assert.match(decoded, SHA256_HEX_PATTERN);
  return decoded;
}

function statusOf(error: unknown): number | null {
  if (!isObject(error) || !("$metadata" in error)) {
    return null;
  }
  const metadata = error.$metadata;
  if (!isObject(metadata) || !("httpStatusCode" in metadata)) {
    return null;
  }
  const status = metadata.httpStatusCode;
  return Number.isInteger(status) ? (status as number) : null;
}

function isSlowDown(error: unknown): boolean {
  return error instanceof Error && error.name === SLOW_DOWN;
}

function transportClass(
  phase: DispatchPhase,
  kind: S3CallKind,
): ResultClassValue {
  assert.ok(Object.values(DispatchPhase).includes(phase));
  if (kind === S3CallKind.Read) {
    return ResultClass.RetryableRefusal;
  }
  return phase === DispatchPhase.BeforeDispatch
    ? ResultClass.ConfirmedFailure
    : ResultClass.UnknownOutcome;
}

function statusClass(status: number, kind: S3CallKind): ResultClassValue {
  assert.ok(Number.isInteger(status));
  assert.ok(Object.values(S3CallKind).includes(kind));
  if (status === HttpStatus.TooManyRequests) {
    return ResultClass.RetryableRefusal;
  }
  if (status >= HttpStatus.InternalServerError) {
    return kind === S3CallKind.Read
      ? ResultClass.RetryableRefusal
      : ResultClass.UnknownOutcome;
  }
  return ResultClass.FinalRefusal;
}

function failure(
  resultClass: ResultClassValue,
  status: number | null,
  message: string,
): S3Failure {
  assert.ok(Object.values(ResultClass).includes(resultClass));
  assert.ok(status === null || Number.isInteger(status));
  return {
    ok: false,
    class: resultClass,
    code: S3_RESULT_CODE_PREFIX + resultClass,
    status,
    message,
  };
}

function classify(
  call: S3Call,
  error: unknown,
  phase: DispatchPhase,
  kind: S3CallKind,
): S3Failure {
  assert.ok(Object.values(S3CallKind).includes(kind));
  const message = thrownReason(error, [call.secretAccessKey, call.accessKeyId]);
  const status = statusOf(error);
  if (isSlowDown(error)) {
    return failure(ResultClass.RetryableRefusal, status, message);
  }
  if (status === null) {
    return failure(transportClass(phase, kind), null, message);
  }
  return failure(statusClass(status, kind), status, message);
}

function dispatchPhaseOf(error: unknown): DispatchPhase {
  let cause: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH_LIMIT; depth += 1) {
    if (!(cause instanceof Error)) {
      return DispatchPhase.AfterDispatch;
    }
    const code = (cause as { code?: unknown }).code;
    if (isString(code) && BEFORE_DISPATCH_CODES.has(code)) {
      return DispatchPhase.BeforeDispatch;
    }
    cause = cause.cause;
  }
  return DispatchPhase.AfterDispatch;
}

function isSdkOutcome(error: unknown): boolean {
  return isObject(error) && "$metadata" in error;
}

function isTransportError(error: unknown): boolean {
  return statusOf(error) === null && !isSlowDown(error);
}

function deadlineError(): Error {
  return new Error("the deadline of the S3 call passed before dispatch");
}

function unexpectedBody(status: number | null, kind: S3CallKind): S3Failure {
  const answer = failure(
    transportClass(DispatchPhase.AfterDispatch, kind),
    status,
    "the S3 answer holds an unexpected body",
  );
  assert.ok(!answer.ok);
  return answer;
}

async function attempt<T>(
  call: S3Call,
  location: S3Location,
  send: Send<T>,
): Promise<Attempt<T>> {
  const remaining = call.deadlineAt - Date.now();
  if (call.signal.aborted || remaining <= NO_TIME_LEFT_MS) {
    return {
      ok: false,
      error: call.signal.aborted ? call.signal.reason : deadlineError(),
      phase: DispatchPhase.BeforeDispatch,
    };
  }
  const signal = AbortSignal.any([call.signal, AbortSignal.timeout(remaining)]);
  const client = clientOf(call, location);
  try {
    return { ok: true, value: await send(client, signal) };
  } catch (error) {
    if (!isSdkOutcome(error) && !signal.aborted) {
      throw error;
    }
    const phase = signal.aborted
      ? DispatchPhase.AfterDispatch
      : dispatchPhaseOf(error);
    return { ok: false, error, phase };
  } finally {
    client.destroy();
  }
}

async function read<T>(
  call: S3Call,
  location: S3Location,
  send: Send<T>,
): Promise<Attempt<T>> {
  let result = await attempt(call, location, send);
  for (let count = 1; count < READ_ATTEMPT_LIMIT; count += 1) {
    if (result.ok || !isTransportError(result.error)) {
      break;
    }
    const remaining = call.deadlineAt - Date.now();
    if (call.signal.aborted || remaining <= NO_TIME_LEFT_MS) {
      break;
    }
    await sleep(Math.min(READ_RETRY_DELAY_MS, remaining));
    result = await attempt(call, location, send);
  }
  return result;
}

function headOf(output: unknown): S3Answer<ObjectHead> {
  const parsed = headAnswerSchema.safeParse(output);
  if (!parsed.success) {
    return unexpectedBody(statusOf(output), S3CallKind.Read);
  }
  const { ContentLength, ChecksumSHA256, ChecksumType, VersionId } =
    parsed.data;
  const whole =
    ChecksumSHA256 !== undefined && ChecksumType !== CHECKSUM_TYPE_COMPOSITE;
  return {
    ok: true,
    value: {
      size: ContentLength,
      sha256: whole ? hexOfBase64(ChecksumSHA256) : null,
      version: VersionId ?? null,
    },
  };
}

export class S3Platform {
  async presignPut(call: S3Call, target: S3PutTarget): Promise<PresignedPut> {
    assert.ok(target.key.length >= MIN_KEY_LENGTH);
    assert.ok(Number.isInteger(target.size) && target.size >= MIN_OBJECT_SIZE);
    const checksum = target.sha256 === null ? null : base64OfHex(target.sha256);
    const headers: Record<string, string> = {
      [CONTENT_LENGTH_HEADER]: String(target.size),
    };
    if (checksum !== null) {
      headers[CHECKSUM_SHA256_HEADER] = checksum;
    }
    const expiresAt = Date.now() + PRESIGN_LIFETIME_S * MS_PER_S;
    const client = clientOf(call, target);
    try {
      const command = new PutObjectCommand({
        Bucket: target.bucket,
        Key: target.key,
        ContentLength: target.size,
        ...(checksum === null ? {} : { ChecksumSHA256: checksum }),
      });
      const putUrl = await getSignedUrl(client, command, {
        expiresIn: PRESIGN_LIFETIME_S,
        signableHeaders: new Set([CONTENT_LENGTH_HEADER]),
        unhoistableHeaders: new Set([CHECKSUM_SHA256_HEADER]),
      });
      return { put_url: putUrl, headers, expires_at: expiresAt };
    } finally {
      client.destroy();
    }
  }

  async presignGet(
    call: S3Call,
    target: S3ObjectTarget,
  ): Promise<PresignedGet> {
    assert.ok(target.key.length >= MIN_KEY_LENGTH);
    assert.ok(
      target.version === null || target.version.length >= MIN_KEY_LENGTH,
    );
    const expiresAt = Date.now() + PRESIGN_LIFETIME_S * MS_PER_S;
    const client = clientOf(call, target);
    try {
      const command = new GetObjectCommand({
        Bucket: target.bucket,
        Key: target.key,
        ...(target.version === null ? {} : { VersionId: target.version }),
      });
      const getUrl = await getSignedUrl(client, command, {
        expiresIn: PRESIGN_LIFETIME_S,
      });
      return { get_url: getUrl, expires_at: expiresAt };
    } finally {
      client.destroy();
    }
  }

  async headObject(
    call: S3Call,
    target: S3ObjectTarget,
  ): Promise<S3Answer<ObjectHead | null>> {
    assert.ok(target.key.length >= MIN_KEY_LENGTH);
    assert.ok(
      target.version === null || target.version.length >= MIN_KEY_LENGTH,
    );
    const command = new HeadObjectCommand({
      Bucket: target.bucket,
      Key: target.key,
      ChecksumMode: "ENABLED",
      ...(target.version === null ? {} : { VersionId: target.version }),
    });
    const result = await read(call, target, (client, abortSignal) =>
      client.send(command, { abortSignal }),
    );
    if (result.ok) {
      return headOf(result.value);
    }
    if (statusOf(result.error) === HttpStatus.NotFound) {
      return { ok: true, value: null };
    }
    return classify(call, result.error, result.phase, S3CallKind.Read);
  }

  async deleteObject(
    call: S3Call,
    target: S3ObjectTarget,
  ): Promise<S3Answer<{ version: string | null }>> {
    assert.ok(target.key.length >= MIN_KEY_LENGTH);
    assert.ok(
      target.version === null || target.version.length >= MIN_KEY_LENGTH,
    );
    const command = new DeleteObjectCommand({
      Bucket: target.bucket,
      Key: target.key,
      ...(target.version === null ? {} : { VersionId: target.version }),
    });
    const result = await attempt(call, target, (client, abortSignal) =>
      client.send(command, { abortSignal }),
    );
    if (!result.ok) {
      return classify(call, result.error, result.phase, S3CallKind.Write);
    }
    const parsed = deleteAnswerSchema.safeParse(result.value);
    if (!parsed.success) {
      return unexpectedBody(statusOf(result.value), S3CallKind.Write);
    }
    return { ok: true, value: { version: parsed.data.VersionId ?? null } };
  }
}
