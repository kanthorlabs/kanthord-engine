import assert from "node:assert/strict";
import {
  AssetUse,
  GrantKind,
  s3AccessKeySecretSchema,
  type AssetFacts,
  type Material,
} from "../custody/contract.ts";
import { isHumanIdentity, type CallerIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  S3_RESULT_CODE_PREFIX,
  type S3Call,
  type S3Failure,
} from "../storage/s3.ts";
import type { IntakeCustody } from "./action-check.ts";
import {
  objectCheckSchema,
  OutboundOperation,
  PLATFORM_CALL_DEADLINE_MS,
  ResultClass,
  type ObjectCheck,
} from "./contract.ts";
import {
  FinalizationKind,
  type CallAnswer,
  type Finalization,
  type OutboundAnswer,
  type OutboundAuthorization,
  type OutboundRun,
  type OutboundScope,
  type ReadBack,
  type ResultCodec,
} from "./outbound.ts";
import { objectTarget, type StorageDependencies } from "./storage.ts";

const BAD_GATEWAY_STATUS = 502;
const NO_DURATION = 0;
const STATUS_CODE_PATTERN = /^[1-5][0-9]{2}$/;

export type DeleteRunner = (request: OutboundRun<null>) => Promise<null>;

interface Held {
  facts: Readonly<AssetFacts> | null;
}

const objectResultCodec: ResultCodec = {
  encode: (value) => objectCheckSchema.parse(value),
  decode: (stored) => objectCheckSchema.parse(stored),
};

export function deleteStoredObject(
  dependencies: StorageDependencies,
  run: DeleteRunner,
  caller: CallerContext,
  assetId: string,
): Promise<null> {
  const identity = caller.identity;
  assert.ok(identity && isHumanIdentity(identity), "A human deletes.");
  assert.ok(assetId.length, "A delete names its evidence asset.");
  const held: Held = { facts: null };
  return run({
    requestKey: assetId,
    deadlineMs: PLATFORM_CALL_DEADLINE_MS,
    resultCodec: objectResultCodec,
    authorize: (tx, now) =>
      authorizeDelete(dependencies.custody, tx, now, {
        identity,
        assetId,
        held,
      }),
    call: (material, scope) =>
      callDelete(dependencies, factsOf(held), material, scope),
    readBack: (material, scope) =>
      readBackDelete(dependencies, factsOf(held), material, scope),
    finalize: finalizeDelete,
  });
}

function factsOf(held: Held): Readonly<AssetFacts> {
  assert.ok(held.facts !== null, "The authorization holds the facts.");
  assert.ok(held.facts.key.length, "An asset names its object key.");
  return held.facts;
}

function authorizeDelete(
  custody: IntakeCustody,
  tx: Transaction,
  now: number,
  request: { identity: CallerIdentity; assetId: string; held: Held },
): OutboundAuthorization {
  const { identity, assetId, held } = request;
  assert.equal(held.facts, null, "A delete authorizes once.");
  const grant = custody.authorizeOperation(
    tx,
    {
      kind: GrantKind.EvidenceAsset,
      identity,
      assetId,
      claim: null,
      use: AssetUse.Delete,
    },
    now,
  );
  const granted = custody.grantFacts(grant);
  assert.ok(granted.credential !== null, "A delete names its credential.");
  held.facts = granted.facts;
  return {
    operation: OutboundOperation.S3DeleteObject,
    project_id: granted.project_id,
    credential: granted.credential,
    material: custody.release(tx, grant, now),
  };
}

async function callDelete(
  dependencies: StorageDependencies,
  facts: Readonly<AssetFacts>,
  material: Material | null,
  scope: OutboundScope,
): Promise<CallAnswer> {
  const answer = await dependencies.s3.deleteObject(
    s3Call(material, scope),
    objectTarget(facts),
  );
  if (!answer.ok) return refusal(answer);
  return { ok: true, result: objectResult(facts) };
}

async function readBackDelete(
  dependencies: StorageDependencies,
  facts: Readonly<AssetFacts>,
  material: Material | null,
  scope: OutboundScope,
): Promise<ReadBack> {
  const head = await dependencies.s3.headObject(
    s3Call(material, scope),
    objectTarget(facts),
  );
  if (!head.ok || head.value !== null) return { match: false };
  return { match: true, result: objectResult(facts) };
}

function finalizeDelete(answer: OutboundAnswer): Finalization<null> {
  if (answer.ok) return { kind: FinalizationKind.Answer, body: null };
  assert.ok(Object.values(ResultClass).includes(answer.class));
  return {
    kind: FinalizationKind.Error,
    error: new OperationError(
      BAD_GATEWAY_STATUS,
      S3_RESULT_CODE_PREFIX + answer.class,
      answer.message,
      { status: storedStatus(answer.code) },
    ),
  };
}

function refusal(failure: S3Failure): CallAnswer {
  assert.equal(failure.ok, false);
  assert.ok(failure.code.length, "An S3 failure names its code.");
  return {
    ok: false,
    class: failure.class,
    code: failure.status === null ? failure.code : String(failure.status),
    message: failure.message,
  };
}

function storedStatus(code: string): number | null {
  assert.ok(code.length, "A failure names its code.");
  if (!STATUS_CODE_PATTERN.test(code)) return null;
  const status = Number(code);
  assert.ok(Number.isInteger(status));
  return status;
}

function objectResult(facts: Readonly<AssetFacts>): ObjectCheck {
  assert.ok(facts.location.length, "An asset names its location.");
  assert.ok(facts.version === null || facts.version.length);
  return { location: facts.location, version: facts.version };
}

function s3Call(material: Material | null, scope: OutboundScope): S3Call {
  assert.ok(material, "An object delete holds a released material.");
  const secret = s3AccessKeySecretSchema.parse(material.value());
  const deadline = scope.context.deadline();
  assert.ok(deadline !== null, "An outbound scope holds a deadline.");
  assert.ok(PLATFORM_CALL_DEADLINE_MS > NO_DURATION);
  return {
    accessKeyId: secret.access_key_id,
    secretAccessKey: secret.secret_access_key,
    signal: scope.signal,
    deadlineAt: Math.min(deadline, Date.now() + PLATFORM_CALL_DEADLINE_MS),
  };
}
