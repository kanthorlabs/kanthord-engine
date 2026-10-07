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
  readNode,
  type NodeRow,
} from "./store.ts";
import { revisionFromRow } from "./revision.ts";

const RESOURCE_KIND_SEGMENT = 0;
const FIRST_MATCH_INDEX = 0;
const NO_REPOSITORY_BINDINGS = 0;
const MINIMUM_ATTEMPT = 0;
const NO_OCCURRENCES = 0;
const SUCCESSFUL_EXIT_CODE = 0;
const SINGLE_BINDING_MATCH = 1;
const OCCURRENCE_INCREMENT = 1;
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
      (binding) =>
        binding.resource_identity.split(SEPARATOR)[RESOURCE_KIND_SEGMENT] ===
        kind,
    );
  assert.ok(matches.length <= SINGLE_BINDING_MATCH);
  return matches[FIRST_MATCH_INDEX] ?? null;
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
    bindingOf(tx, bindings, revision, MissionBindingKind.Storage)?.binding_id ??
    null
  );
}

function bindingMismatch(bindingId: string): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.EvidenceBindingMismatch,
    "Repository binding does not match the node.",
    { binding_id: bindingId },
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
  assert.equal(revision.node_id, node.id);
  if (node.kind === NodeKind.Objective) {
    if (
      repositoryBindingOf(tx, bindings, revision)?.binding_id !==
      address.binding_id
    )
      bindingMismatch(address.binding_id);
    return;
  }
  const mission = readMission(tx, node.mission_id);
  assert.ok(mission);
  const binding = bindings.getBindingRevision(tx, address.binding_id);
  if (
    !binding ||
    binding.project_id !== mission.project_id ||
    binding.resource_identity.split(SEPARATOR)[RESOURCE_KIND_SEGMENT] !==
      MissionBindingKind.Repository
  )
    bindingMismatch(address.binding_id);
}

export function repositoryBindingIdsOf(
  tx: Transaction,
  bindings: MissionBindings,
  nodeId: string,
  nodeRevision: number,
): string[] {
  const node = readNode(tx, nodeId);
  assert.ok(node);
  if (node.kind === NodeKind.Objective) {
    const binding = repositoryBindingOf(
      tx,
      bindings,
      getRevision(tx, nodeId, nodeRevision),
    );
    return binding ? [binding.binding_id] : [];
  }
  assert.equal(node.kind, NodeKind.Initiative);
  assert.ok(tx.database.isTransaction);
  const objectives = readMissionNodes(tx, node.mission_id).filter(
    (child) =>
      child.parent_id === node.id &&
      child.kind === NodeKind.Objective &&
      child.retired_at === null,
  );
  const resources = new Map<string, { binding_id: string; revision: number }>();
  for (const child of objectives) {
    const row = readCurrentRevision(tx, child.id);
    assert.ok(row);
    const binding = repositoryBindingOf(tx, bindings, revisionFromRow(tx, row));
    if (!binding) continue;
    const previous = resources.get(binding.resource_identity);
    if (!previous || previous.revision < binding.revision)
      resources.set(binding.resource_identity, binding);
  }
  return [...resources.values()].map(({ binding_id: bindingId }) => bindingId);
}

export function requireTestedInput(
  tx: Transaction,
  bindings: MissionBindings,
  node: NodeRow,
  revision: Revision,
  testedInput: TestedInput,
): void {
  assert.notEqual(node.kind, NodeKind.Task);
  assert.equal(revision.node_id, node.id);
  if (node.kind === NodeKind.Objective) {
    if (Array.isArray(testedInput)) invalidExecutionInput("tested_input");
    if (testedInput.kind === AssetKind.Repository)
      requireRepositoryAddress(tx, bindings, node, revision, testedInput);
    return;
  }
  const resources = new Set(
    repositoryBindingIdsOf(tx, bindings, node.id, revision.revision).map(
      (id) => {
        const binding = bindings.getBindingRevision(tx, id);
        assert.ok(binding);
        return binding.resource_identity;
      },
    ),
  );
  if (resources.size === NO_REPOSITORY_BINDINGS) {
    if (Array.isArray(testedInput) || testedInput.kind === AssetKind.Repository)
      invalidExecutionInput("tested_input");
    return;
  }
  if (!Array.isArray(testedInput)) invalidExecutionInput("tested_input");
  const seen = new Set<string>();
  for (const address of testedInput) {
    requireRepositoryAddress(tx, bindings, node, revision, address);
    const binding = bindings.getBindingRevision(tx, address.binding_id);
    assert.ok(binding);
    if (
      !resources.has(binding.resource_identity) ||
      seen.has(binding.resource_identity)
    )
      bindingMismatch(address.binding_id);
    seen.add(binding.resource_identity);
  }
  if (seen.size !== resources.size) invalidExecutionInput("tested_input");
}

export function producedContent(bytes: { media_type: string; data: string }) {
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
    media_type: bytes.media_type,
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
  assert.equal(binding.project_id, projectId);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= MINIMUM_ATTEMPT);
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
  assert.equal(revision.node_id, node.id);
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

export function verificationCovers(
  verification: Verification,
  expected: readonly string[],
): boolean {
  if (verification.results.length !== expected.length) return false;
  const remaining = new Map<string, number>();
  for (const command of expected)
    remaining.set(
      command,
      (remaining.get(command) ?? NO_OCCURRENCES) + OCCURRENCE_INCREMENT,
    );
  for (const result of verification.results) {
    const count = remaining.get(result.command) ?? NO_OCCURRENCES;
    if (count === NO_OCCURRENCES) return false;
    remaining.set(result.command, count - OCCURRENCE_INCREMENT);
  }
  return true;
}

export function verificationPasses(
  verification: Verification,
  expected: readonly string[],
): boolean {
  return (
    verificationCovers(verification, expected) &&
    verification.results.every(
      (result) => result.exit_code === SUCCESSFUL_EXIT_CODE,
    )
  );
}
