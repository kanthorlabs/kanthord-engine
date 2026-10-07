import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssetKind,
  INLINE_BYTES_MAX,
  MissionErrorCode,
  NodeKind,
  NodeState,
  repositoryAddressSchema,
  type Revision,
  type StorageBinding,
  type Verification,
} from "./contract.ts";
import {
  keyOfLocation,
  objectKey,
  objectLocation,
  producedContent,
  repositoryBindingOf,
  repositoryBindingIdsOf,
  requiredVerifications,
  requireRepositoryAddress,
  requireTestedInput,
  storageBindingIdOf,
  verificationPasses,
} from "./evidence-content.ts";
import { getRevision } from "./node-read.ts";
import { insertNode, insertRevision, readNode, setNodeState } from "./store.ts";
import { executionHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const COMMIT = "a".repeat(40);
const NOW = 200;
const FIRST_REVISION = 1;
const BYTE_OVERFLOW = 1;
const FAILURE_EXIT_CODE = 1;
const SUCCESS_EXIT_CODE = 0;
const CHILD_COUNT = 3;
const RESOURCE = "repository:github:owner/repository";
const OTHER_RESOURCE = "repository:github:owner/other";
const VALIDATION = "gateway.request.validation_failed";

test("repository commits require complete lowercase SHA-1 or SHA-256 values", () => {
  const base = {
    kind: AssetKind.Repository,
    binding_id: createIdentity("binding"),
  };
  for (const commit of [COMMIT, "b".repeat(64)])
    assert.ok(repositoryAddressSchema.safeParse({ ...base, commit }).success);
  for (const commit of ["abcdef", "A".repeat(40), "main"])
    assert.equal(
      repositoryAddressSchema.safeParse({ ...base, commit }).success,
      false,
    );
});

test("content checks pinned objective bindings and distinct current initiative resources including discarded objectives", (t) => {
  const h = executionHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  const laterId = createIdentity("binding");
  const otherId = createIdentity("binding");
  const storageId = createIdentity("binding");
  h.dependencies.bindings.getBindingRevision = (_tx, id) => ({
    binding_id: id,
    project_id: h.project_id,
    name: id,
    resource_identity:
      id === storageId
        ? "storage:s3:bucket"
        : id === otherId
          ? OTHER_RESOURCE
          : RESOURCE,
    revision: id === laterId ? FIRST_REVISION + FIRST_REVISION : FIRST_REVISION,
    tombstone: false,
    disabled: false,
  });
  h.store.transaction((tx) => {
    const revision = getRevision(tx, h.node_id, FIRST_REVISION);
    const initiative = readNode(tx, h.node_id)!;
    assert.deepEqual(
      h.service.repositoryBindingIdsOf(tx, h.node_id, FIRST_REVISION),
      [],
    );
    const address = {
      kind: AssetKind.Repository,
      binding_id: bindingId,
      commit: COMMIT,
    } as const;
    requireTestedInput(tx, h.dependencies.bindings, initiative, revision, {
      kind: AssetKind.Produced,
      sha256: "a".repeat(64),
    });
    assert.throws(
      () =>
        requireTestedInput(tx, h.dependencies.bindings, initiative, revision, [
          address,
        ]),
      (error) => error instanceof OperationError && error.code === VALIDATION,
    );
    const childBindingIds = [bindingId, laterId, otherId];
    const childNodeIds = childBindingIds
      .map(() => createIdentity("node"))
      .sort();
    const children: string[] = [];
    for (const [index, id] of childBindingIds.entries()) {
      const nodeId = childNodeIds[index]!;
      children.push(nodeId);
      insertNode(tx, {
        id: nodeId,
        mission_id: h.mission_id,
        kind: NodeKind.Objective,
        filename: `${nodeId}.md`,
        parent_id: h.node_id,
        created_at: NOW,
      });
      const childRevision: Revision = {
        ...revision,
        node_id: nodeId,
        content: { ...revision.content, bindings: [id, storageId] },
        tasks: [],
      };
      insertRevision(tx, childRevision);
      setNodeState(tx, nodeId, NodeState.Discarded);
      assert.deepEqual(
        repositoryBindingIdsOf(
          tx,
          h.dependencies.bindings,
          nodeId,
          FIRST_REVISION,
        ),
        [id],
      );
      const child = readNode(tx, nodeId)!;
      assert.equal(
        repositoryBindingOf(tx, h.dependencies.bindings, childRevision)
          ?.binding_id,
        id,
      );
      assert.equal(
        storageBindingIdOf(tx, h.dependencies.bindings, childRevision),
        storageId,
      );
      requireRepositoryAddress(
        tx,
        h.dependencies.bindings,
        child,
        childRevision,
        { ...address, binding_id: id },
      );
      assert.throws(
        () =>
          requireRepositoryAddress(
            tx,
            h.dependencies.bindings,
            child,
            childRevision,
            { ...address, binding_id: storageId },
          ),
        (error) =>
          error instanceof OperationError &&
          error.code === MissionErrorCode.EvidenceBindingMismatch,
      );
      assert.throws(
        () =>
          requireTestedInput(
            tx,
            h.dependencies.bindings,
            child,
            childRevision,
            [address],
          ),
        (error) => error instanceof OperationError && error.code === VALIDATION,
      );
    }
    assert.deepEqual(
      h.service.repositoryBindingIdsOf(tx, h.node_id, FIRST_REVISION),
      [laterId, otherId],
    );
    requireTestedInput(tx, h.dependencies.bindings, initiative, revision, [
      address,
      { ...address, binding_id: otherId },
    ]);
    assert.throws(
      () =>
        requireTestedInput(tx, h.dependencies.bindings, initiative, revision, [
          address,
        ]),
      (error) => error instanceof OperationError && error.code === VALIDATION,
    );
    assert.throws(
      () =>
        requireTestedInput(tx, h.dependencies.bindings, initiative, revision, [
          address,
          address,
        ]),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.EvidenceBindingMismatch,
    );
    h.dependencies.bindings.getBindingRevision = () => null;
    assert.throws(
      () =>
        requireRepositoryAddress(
          tx,
          h.dependencies.bindings,
          initiative,
          revision,
          address,
        ),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.EvidenceBindingMismatch,
    );
    assert.equal(children.length, CHILD_COUNT);
  });
});

test("produced bytes have canonical base64, an exact decoded limit and the decoded digest", () => {
  const decoded = Buffer.alloc(INLINE_BYTES_MAX);
  const content = producedContent({
    media_type: "application/octet-stream",
    data: decoded.toString("base64"),
  });
  assert.equal(
    content.sha256,
    createHash("sha256").update(decoded).digest("hex"),
  );
  assert.throws(
    () =>
      producedContent({
        media_type: content.media_type,
        data: Buffer.alloc(INLINE_BYTES_MAX + BYTE_OVERFLOW).toString("base64"),
      }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.EvidenceTooLarge,
  );
  for (const data of ["Zg", "Zg==\n", "Zh==", "???"])
    assert.throws(
      () => producedContent({ media_type: content.media_type, data }),
      (error) => error instanceof OperationError && error.code === VALIDATION,
    );
});

test("object locations preserve the pinned prefix and enforce bucket ownership", () => {
  const binding: StorageBinding = {
    binding_id: createIdentity("binding"),
    project_id: createIdentity("project"),
    endpoint: "https://storage.example",
    bucket: "bucket",
    region: "region",
    prefix: "prefix",
    credential: "storage",
    available: true,
  };
  const missionId = createIdentity("mission");
  const nodeId = createIdentity("node");
  const assetId = createIdentity("asset");
  const key = objectKey(
    binding,
    binding.project_id,
    missionId,
    nodeId,
    FIRST_REVISION,
    assetId,
  );
  assert.equal(
    key,
    `prefix/${binding.project_id}/${missionId}/${nodeId}/1/${assetId}`,
  );
  const location = objectLocation(binding, key);
  assert.equal(location, `s3://bucket/${key}`);
  assert.equal(keyOfLocation(binding, location), key);
  assert.throws(() => keyOfLocation(binding, `s3://other/${key}`));
});

test("verification coverage compares command multisets including pinned tasks", (t) => {
  const h = executionHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    const revision = getRevision(tx, h.node_id, FIRST_REVISION);
    const node = { ...readNode(tx, h.node_id)!, kind: NodeKind.Objective };
    revision.tasks = [
      {
        id: createIdentity("node"),
        filename: "task.md",
        content: { ...revision.content, verifications: ["task", "true"] },
      },
    ];
    const expected = requiredVerifications(tx, node, revision);
    assert.deepEqual(expected, ["true", "task", "true"]);
    const result = (command: string, exitCode = SUCCESS_EXIT_CODE) => ({
      command,
      exit_code: exitCode,
      signal: null,
      timed_out: false,
    });
    const verification: Verification = {
      tested_input: { kind: AssetKind.Produced, sha256: "b".repeat(64) },
      results: [result("task"), result("true"), result("true")],
    };
    assert.ok(verificationPasses(verification, expected));
    for (const results of [
      [result("true")],
      [...verification.results, result("extra")],
      [result("task"), result("true"), result("true", FAILURE_EXIT_CODE)],
      [result("task"), result("task"), result("true")],
    ])
      assert.equal(
        verificationPasses({ ...verification, results }, expected),
        false,
      );
  });
});
