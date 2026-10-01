import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssetKind,
  CONTENT_ENCODING,
  INLINE_BYTES_MAX,
  MissionBindingKind,
  MissionErrorCode,
  NodeKind,
  type MissionBindings,
  type RepositoryAddress,
  type Revision,
  type StorageBinding,
  type TestedInput,
  type Verification,
} from "./contract.ts";
import { invalidExecutionInput } from "./execution.ts";
import { getRevision } from "./node-read.ts";
import {
  readCurrentRevision,
  readMission,
  readMissionNodes,
  type NodeRow,
} from "./store.ts";
import { revisionFromRow } from "./revision.ts";

const ZERO = 0;
const ONE = 1;
const SEPARATOR = ":";
const SHA256 = "sha256";
const HEX = "hex";

function bindingOf(
  tx: Transaction,
  bindings: MissionBindings,
  revision: Revision,
  kind: (typeof MissionBindingKind)[keyof typeof MissionBindingKind],
) {
  assert.ok(tx.database.isTransaction);
  const matches = revision.content.bindings
    .map((id) => {
      const binding = bindings.getBindingRevision(tx, id);
      assert.ok(binding);
      return binding;
    })
    .filter(
      (binding) => binding.resourceIdentity.split(SEPARATOR)[ZERO] === kind,
    );
  assert.ok(matches.length <= ONE);
  return matches[ZERO] ?? null;
}

export function repositoryBindingOf(
  tx: Transaction,
  bindings: MissionBindings,
  revision: Revision,
) {
  return bindingOf(tx, bindings, revision, MissionBindingKind.Repository);
}

export function storageBindingIdOf(
  tx: Transaction,
  bindings: MissionBindings,
  revision: Revision,
): string | null {
  return (
    bindingOf(tx, bindings, revision, MissionBindingKind.Storage)?.bindingId ??
    null
  );
}

function bindingMismatch(bindingId: string): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.EvidenceBindingMismatch,
    "Repository binding does not match the node.",
    { bindingId },
  );
}

export function requireRepositoryAddress(
  tx: Transaction,
  bindings: MissionBindings,
  node: NodeRow,
  revision: Revision,
  address: RepositoryAddress,
): void {
  assert.notEqual(node.kind, NodeKind.Task);
  assert.equal(revision.nodeId, node.id);
  if (node.kind === NodeKind.Objective) {
    if (
      repositoryBindingOf(tx, bindings, revision)?.bindingId !==
      address.bindingId
    )
      bindingMismatch(address.bindingId);
    return;
  }
  const mission = readMission(tx, node.mission_id);
  assert.ok(mission);
  const binding = bindings.getBindingRevision(tx, address.bindingId);
  if (
    !binding ||
    binding.projectId !== mission.projectId ||
    binding.resourceIdentity.split(SEPARATOR)[ZERO] !==
      MissionBindingKind.Repository
  )
    bindingMismatch(address.bindingId);
}

export function objectiveRepositories(
  tx: Transaction,
  bindings: MissionBindings,
  node: NodeRow,
): Set<string> {
  assert.equal(node.kind, NodeKind.Initiative);
  assert.ok(tx.database.isTransaction);
  const objectives = readMissionNodes(tx, node.mission_id).filter(
    (child) =>
      child.parent_id === node.id &&
      child.kind === NodeKind.Objective &&
      child.retired_at === null,
  );
  const resources = new Set<string>();
  for (const child of objectives) {
    const row = readCurrentRevision(tx, child.id);
    assert.ok(row);
    const binding = repositoryBindingOf(tx, bindings, revisionFromRow(tx, row));
    if (binding) resources.add(binding.resourceIdentity);
  }
  return resources;
}

export function requireTestedInput(
  tx: Transaction,
  bindings: MissionBindings,
  node: NodeRow,
  revision: Revision,
  testedInput: TestedInput,
): void {
  assert.notEqual(node.kind, NodeKind.Task);
  assert.equal(revision.nodeId, node.id);
  if (node.kind === NodeKind.Objective) {
    if (Array.isArray(testedInput)) invalidExecutionInput("testedInput");
    if (testedInput.kind === AssetKind.Repository)
      requireRepositoryAddress(tx, bindings, node, revision, testedInput);
    return;
  }
  const resources = objectiveRepositories(tx, bindings, node);
  if (resources.size === ZERO) {
    if (Array.isArray(testedInput) || testedInput.kind === AssetKind.Repository)
      invalidExecutionInput("testedInput");
    return;
  }
  if (!Array.isArray(testedInput)) invalidExecutionInput("testedInput");
  const seen = new Set<string>();
  for (const address of testedInput) {
    requireRepositoryAddress(tx, bindings, node, revision, address);
    const binding = bindings.getBindingRevision(tx, address.bindingId);
    assert.ok(binding);
    if (
      !resources.has(binding.resourceIdentity) ||
      seen.has(binding.resourceIdentity)
    )
      bindingMismatch(address.bindingId);
    seen.add(binding.resourceIdentity);
  }
  if (seen.size !== resources.size) invalidExecutionInput("testedInput");
}

export function producedContent(bytes: { mediaType: string; data: string }) {
  const decoded = Buffer.from(bytes.data, CONTENT_ENCODING);
  if (decoded.toString(CONTENT_ENCODING) !== bytes.data)
    invalidExecutionInput("assets");
  if (decoded.byteLength > INLINE_BYTES_MAX)
    throw new OperationError(
      HttpStatus.PayloadTooLarge,
      MissionErrorCode.EvidenceTooLarge,
      "Inline evidence exceeds the byte limit.",
    );
  return {
    mediaType: bytes.mediaType,
    sha256: createHash(SHA256).update(decoded).digest(HEX),
    data: bytes.data,
  };
}

export function objectKey(
  binding: StorageBinding,
  projectId: string,
  missionId: string,
  nodeId: string,
  attempt: number,
  assetId: string,
): string {
  assert.equal(binding.projectId, projectId);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= ZERO);
  return [binding.prefix, projectId, missionId, nodeId, attempt, assetId].join(
    "/",
  );
}

export function objectLocation(binding: StorageBinding, key: string): string {
  assert.ok(binding.bucket);
  assert.ok(key);
  return `s3://${binding.bucket}/${key}`;
}

export function keyOfLocation(
  binding: StorageBinding,
  location: string,
): string {
  const prefix = `s3://${binding.bucket}/`;
  assert.ok(location.startsWith(prefix));
  assert.ok(location.length > prefix.length);
  return location.slice(prefix.length);
}

export function requiredVerifications(
  tx: Transaction,
  node: NodeRow,
  revision: Revision,
): string[] {
  assert.notEqual(node.kind, NodeKind.Task);
  assert.equal(revision.nodeId, node.id);
  const commands = [...revision.content.verifications];
  if (node.kind === NodeKind.Objective) {
    for (const task of revision.tasks ?? [])
      commands.push(...task.content.verifications);
  }
  assert.equal(
    getRevision(tx, node.id, revision.revision).revision,
    revision.revision,
  );
  return commands;
}

export function verificationPasses(
  verification: Verification,
  expected: readonly string[],
): boolean {
  if (verification.results.length !== expected.length) return false;
  const remaining = new Map<string, number>();
  for (const command of expected)
    remaining.set(command, (remaining.get(command) ?? ZERO) + ONE);
  for (const result of verification.results) {
    const count = remaining.get(result.command) ?? ZERO;
    if (result.exitCode !== ZERO || count === ZERO) return false;
    remaining.set(result.command, count - ONE);
  }
  return true;
}
