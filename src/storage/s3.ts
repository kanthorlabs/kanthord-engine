import assert from "node:assert/strict";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRESIGN_LIFETIME_S } from "../intake/contract.ts";

export const CONTENT_LENGTH_HEADER = "content-length";
export const CHECKSUM_SHA256_HEADER = "x-amz-checksum-sha256";
const MS_PER_S = 1000;
const MIN_SECRET_LENGTH = 1;
const MIN_KEY_LENGTH = 1;
const MIN_OBJECT_SIZE = 0;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_BASE64_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

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

export interface PresignedPut {
  put_url: string;
  headers: Record<string, string>;
  expires_at: number;
}

export interface PresignedGet {
  get_url: string;
  expires_at: number;
}

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
}
