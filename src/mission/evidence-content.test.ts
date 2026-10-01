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
const FIRST = 1;
const ZERO = 0;
const CHILD_COUNT = 3;
const RESOURCE = "repository:github:owner/repository";
const OTHER_RESOURCE = "repository:github:owner/other";
const VALIDATION = "gateway.request.validation_failed";

test("repository commits require complete lowercase SHA-1 or SHA-256 values", () => {
  const base = {
    kind: AssetKind.Repository,
    bindingId: createIdentity("binding"),
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
  const otherId = createIdentity("binding");
  const storageId = createIdentity("binding");
  h.dependencies.bindings.getBindingRevision = (_tx, id) => ({
    bindingId: id,
    projectId: h.projectId,
    name: id,
    resourceIdentity:
      id === storageId
        ? "storage:s3:bucket"
        : id === otherId
          ? OTHER_RESOURCE
          : RESOURCE,
    revision: FIRST,
    tombstone: false,
    disabled: false,
  });
  h.store.transaction((tx) => {
    const revision = getRevision(tx, h.nodeId, FIRST);
    const initiative = readNode(tx, h.nodeId)!;
    const address = {
      kind: AssetKind.Repository,
      bindingId,
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
    const children: string[] = [];
    for (const id of [bindingId, bindingId, otherId]) {
      const nodeId = createIdentity("node");
      children.push(nodeId);
      insertNode(tx, {
        id: nodeId,
        mission_id: h.missionId,
        kind: NodeKind.Objective,
        filename: `${nodeId}.md`,
        parent_id: h.nodeId,
        created_at: NOW,
      });
      const childRevision: Revision = {
        ...revision,
        nodeId,
        content: { ...revision.content, bindings: [id, storageId] },
        tasks: [],
      };
      insertRevision(tx, childRevision);
      setNodeState(tx, nodeId, NodeState.Discarded);
      const child = readNode(tx, nodeId)!;
      assert.equal(
        repositoryBindingOf(tx, h.dependencies.bindings, childRevision)
          ?.bindingId,
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
        { ...address, bindingId: id },
      );
      assert.throws(
        () =>
          requireRepositoryAddress(
            tx,
            h.dependencies.bindings,
            child,
            childRevision,
            { ...address, bindingId: storageId },
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
    requireTestedInput(tx, h.dependencies.bindings, initiative, revision, [
      address,
      { ...address, bindingId: otherId },
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
    mediaType: "application/octet-stream",
    data: decoded.toString("base64"),
  });
  assert.equal(
    content.sha256,
    createHash("sha256").update(decoded).digest("hex"),
  );
  assert.throws(
    () =>
      producedContent({
        mediaType: content.mediaType,
        data: Buffer.alloc(INLINE_BYTES_MAX + FIRST).toString("base64"),
      }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.EvidenceTooLarge,
  );
  for (const data of ["Zg", "Zg==\n", "Zh==", "???"])
    assert.throws(
      () => producedContent({ mediaType: content.mediaType, data }),
      (error) => error instanceof OperationError && error.code === VALIDATION,
    );
});

test("object locations preserve the pinned prefix and enforce bucket ownership", () => {
  const binding: StorageBinding = {
    bindingId: createIdentity("binding"),
    projectId: createIdentity("project"),
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
    binding.projectId,
    missionId,
    nodeId,
    FIRST,
    assetId,
  );
  assert.equal(
    key,
    `prefix/${binding.projectId}/${missionId}/${nodeId}/1/${assetId}`,
  );
  const location = objectLocation(binding, key);
  assert.equal(location, `s3://bucket/${key}`);
  assert.equal(keyOfLocation(binding, location), key);
  assert.throws(() => keyOfLocation(binding, `s3://other/${key}`));
});

test("verification coverage compares command multisets including pinned tasks", (t) => {
  const h = executionHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    const revision = getRevision(tx, h.nodeId, FIRST);
    const node = { ...readNode(tx, h.nodeId)!, kind: NodeKind.Objective };
    revision.tasks = [
      {
        id: createIdentity("node"),
        filename: "task.md",
        content: { ...revision.content, verifications: ["task", "true"] },
      },
    ];
    const expected = requiredVerifications(tx, node, revision);
    assert.deepEqual(expected, ["true", "task", "true"]);
    const result = (command: string, exitCode = ZERO) => ({
      command,
      exitCode,
      signal: null,
      timedOut: false,
    });
    const verification: Verification = {
      testedInput: { kind: AssetKind.Produced, sha256: "b".repeat(64) },
      results: [result("task"), result("true"), result("true")],
    };
    assert.ok(verificationPasses(verification, expected));
    for (const results of [
      [result("true")],
      [...verification.results, result("extra")],
      [result("task"), result("true"), result("true", FIRST)],
      [result("task"), result("task"), result("true")],
    ])
      assert.equal(
        verificationPasses({ ...verification, results }, expected),
        false,
      );
  });
});
