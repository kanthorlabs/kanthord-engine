import assert from "node:assert/strict";
import {
  AssetUse,
  GrantKind,
  s3AccessKeySecretSchema,
  type AssetFacts,
  type GrantRequest,
  type Material,
} from "../custody/contract.ts";
import {
  isHumanIdentity,
  isMachineIdentity,
  type MachineIdentity,
} from "../kernel/caller.ts";
import { abortSignal } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  S3_RESULT_CODE_PREFIX,
  type ObjectHead,
  type S3Call,
  type S3Failure,
  type S3ObjectTarget,
  type S3Platform,
} from "../storage/s3.ts";
import type { IntakeCustody } from "./action-check.ts";
import {
  IntakeErrorCode,
  PLATFORM_CALL_DEADLINE_MS,
  READ_ANSWER_MARGIN_MS,
  ResultClass,
  type ObjectCheck,
  type PresignedGetAnswer,
  type PresignedPutAnswer,
} from "./contract.ts";

const BAD_GATEWAY_STATUS = 502;
const OBJECT_MISMATCH_MESSAGE =
  "The stored object is absent or differs from the asset size or SHA-256.";

export interface StorageDependencies {
  store: Store;
  custody: IntakeCustody;
  s3: S3Platform;
}

export type ObjectPutBody = {
  node_id: string;
  asset_id: string;
  storage_binding_id: string;
  size: number;
  sha256: string | null;
};

type ObjectRequest = Extract<
  GrantRequest,
  { kind: typeof GrantKind.EvidenceAsset | typeof GrantKind.ObjectPut }
>;

type StorageCall<T> = (call: S3Call, facts: Readonly<AssetFacts>) => Promise<T>;

interface Executor {
  identity: MachineIdentity;
  claim: ExecutionClaim;
}

interface Hold {
  material: Material | null;
}

export function putObject(
  dependencies: StorageDependencies,
  caller: CallerContext,
  body: ObjectPutBody,
): Promise<PresignedPutAnswer> {
  const { identity, claim } = executorOf(caller);
  assert.ok(body.asset_id.length);
  const request: ObjectRequest = {
    kind: GrantKind.ObjectPut,
    identity,
    claim,
    nodeId: body.node_id,
    assetId: body.asset_id,
    storageBindingId: body.storage_binding_id,
    size: body.size,
    sha256: body.sha256,
  };
  return withObjectGrant(dependencies, caller, request, (call, facts) =>
    dependencies.s3.presignPut(call, {
      endpoint: facts.storage.endpoint,
      bucket: facts.storage.bucket,
      region: facts.storage.region,
      key: facts.key,
      size: facts.size,
      sha256: facts.sha256,
    }),
  );
}

export function checkObject(
  dependencies: StorageDependencies,
  caller: CallerContext,
  assetId: string,
): Promise<ObjectCheck> {
  const { identity, claim } = executorOf(caller);
  assert.ok(assetId.length);
  const request: ObjectRequest = {
    kind: GrantKind.EvidenceAsset,
    identity,
    assetId,
    claim,
    use: AssetUse.Check,
  };
  return withObjectGrant(dependencies, caller, request, async (call, facts) => {
    const head = await dependencies.s3.headObject(call, objectTarget(facts));
    if (!head.ok) throw platformFailure(head);
    if (!objectMatches(head.value, facts))
      throw new OperationError(
        HttpStatus.Conflict,
        IntakeErrorCode.StorageObjectMismatch,
        OBJECT_MISMATCH_MESSAGE,
      );
    return { location: facts.location, version: head.value.version };
  });
}

export function executionGetObject(
  dependencies: StorageDependencies,
  caller: CallerContext,
  assetId: string,
): Promise<PresignedGetAnswer> {
  const { identity, claim } = executorOf(caller);
  assert.ok(assetId.length);
  const request: ObjectRequest = {
    kind: GrantKind.EvidenceAsset,
    identity,
    assetId,
    claim,
    use: AssetUse.ExecutionGet,
  };
  return withObjectGrant(dependencies, caller, request, (call, facts) =>
    dependencies.s3.presignGet(call, objectTarget(facts)),
  );
}

export function getObject(
  dependencies: StorageDependencies,
  caller: CallerContext,
  assetId: string,
): Promise<PresignedGetAnswer> {
  const identity = caller.identity;
  assert.ok(identity && isHumanIdentity(identity), "A human reads.");
  assert.ok(assetId.length);
  const request: ObjectRequest = {
    kind: GrantKind.EvidenceAsset,
    identity,
    assetId,
    claim: null,
    use: AssetUse.Get,
  };
  return withObjectGrant(dependencies, caller, request, (call, facts) =>
    dependencies.s3.presignGet(call, objectTarget(facts)),
  );
}

function executorOf(caller: CallerContext): Executor {
  const identity = caller.identity;
  const claim = caller.execution;
  assert.ok(identity && isMachineIdentity(identity), "A client calls.");
  assert.ok(claim, "A client call holds a proven execution claim.");
  return { identity, claim };
}

async function withObjectGrant<T>(
  dependencies: StorageDependencies,
  caller: CallerContext,
  request: ObjectRequest,
  run: StorageCall<T>,
): Promise<T> {
  const hold: Hold = { material: null };
  try {
    const facts = dependencies.store.transaction((tx) =>
      authorizeObject(dependencies.custody, tx, request, hold),
    );
    assert.ok(hold.material, "An object call holds a released material.");
    const answer = await callStorage(caller, hold.material, (call) =>
      run(call, facts),
    );
    return caller.commit(() => answer);
  } finally {
    hold.material?.drop();
  }
}

function authorizeObject(
  custody: IntakeCustody,
  tx: Transaction,
  request: ObjectRequest,
  hold: Hold,
): Readonly<AssetFacts> {
  assert.equal(hold.material, null, "An object call releases once.");
  const now = Date.now();
  const grant = custody.authorizeOperation(tx, request, now);
  const { credential, facts } = custody.grantFacts(grant);
  assert.ok(credential !== null, "An object grant names its credential.");
  hold.material = custody.release(tx, grant, now);
  return facts;
}

async function callStorage<T>(
  caller: CallerContext,
  material: Material,
  run: (call: S3Call) => Promise<T>,
): Promise<T> {
  const secret = s3AccessKeySecretSchema.parse(material.value());
  assert.ok(secret.access_key_id.length);
  const deadline = caller.context.deadline();
  const callDeadlineAt = Date.now() + PLATFORM_CALL_DEADLINE_MS;
  const { signal, dispose } = abortSignal(caller.context);
  try {
    return await run({
      accessKeyId: secret.access_key_id,
      secretAccessKey: secret.secret_access_key,
      signal,
      deadlineAt:
        deadline === null
          ? callDeadlineAt
          : Math.min(callDeadlineAt, deadline - READ_ANSWER_MARGIN_MS),
    });
  } finally {
    dispose();
  }
}

export function objectTarget(facts: Readonly<AssetFacts>): S3ObjectTarget {
  assert.ok(facts.key.length);
  assert.ok(facts.storage.bucket.length);
  return {
    endpoint: facts.storage.endpoint,
    bucket: facts.storage.bucket,
    region: facts.storage.region,
    key: facts.key,
    version: facts.version,
  };
}

function objectMatches(
  head: ObjectHead | null,
  facts: Readonly<AssetFacts>,
): head is ObjectHead {
  assert.ok(Number.isInteger(facts.size));
  if (head === null) return false;
  if (head.size !== facts.size) return false;
  return facts.sha256 === null || head.sha256 === facts.sha256;
}

function platformFailure(failure: S3Failure): OperationError {
  assert.equal(failure.ok, false);
  assert.ok(Object.values(ResultClass).includes(failure.class));
  return new OperationError(
    BAD_GATEWAY_STATUS,
    S3_RESULT_CODE_PREFIX + failure.class,
    failure.message,
    { status: failure.status },
  );
}
