import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssetKind,
  INLINE_BYTES_MAX,
  Intent,
  MissionErrorCode,
  NodeState,
  repositoryAddressSchema,
  type Revision,
  type StorageBinding,
  type TestedInput,
  type Verification,
} from "./contract.ts";
import {
  keyOfLocation,
  objectKey,
  objectLocation,
  producedContent,
  repositoryBindingIdsOf,
  requiredVerifications,
  requireRepositoryAddress,
  requireTestedInput,
  storageBindingIdsOf,
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
const IMPLEMENT_COUNT = 3;
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

test("the tested input of an examine node with two repository bindings is a list in binding order, and an implement node checks its pinned bindings", (t) => {
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
    const examine = readNode(tx, h.node_id)!;
    assert.deepEqual(
      h.service.repositoryBindingIdsOf(tx, h.node_id, FIRST_REVISION),
      [],
    );
    const address = {
      kind: AssetKind.Repository,
      binding_id: bindingId,
      commit: COMMIT,
    } as const;
    requireTestedInput(tx, h.dependencies.bindings, examine, revision, {
      kind: AssetKind.Produced,
      sha256: "a".repeat(64),
    });
    assert.throws(
      () =>
        requireTestedInput(tx, h.dependencies.bindings, examine, revision, [
          address,
        ]),
      (error) => error instanceof OperationError && error.code === VALIDATION,
    );
    const implementBindingIds = [bindingId, laterId, otherId];
    const implementNodeIds = implementBindingIds
      .map(() => createIdentity("node"))
      .sort();
    const implementNodes: string[] = [];
    for (const [index, id] of implementBindingIds.entries()) {
      const nodeId = implementNodeIds[index]!;
      implementNodes.push(nodeId);
      insertNode(tx, {
        id: nodeId,
        mission_id: h.mission_id,
        filename: `${nodeId}.md`,
        created_at: NOW,
      });
      const implementRevision: Revision = {
        ...revision,
        node_id: nodeId,
        content: {
          ...revision.content,
          intent: Intent.Implement,
          bindings: [id, storageId],
        },
        tasks: [],
      };
      insertRevision(tx, implementRevision);
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
      const implement = readNode(tx, nodeId)!;
      assert.deepEqual(
        storageBindingIdsOf(tx, h.dependencies.bindings, implementRevision),
        [storageId],
      );
      requireRepositoryAddress(
        tx,
        h.dependencies.bindings,
        implement,
        implementRevision,
        { ...address, binding_id: id },
      );
      assert.throws(
        () =>
          requireRepositoryAddress(
            tx,
            h.dependencies.bindings,
            implement,
            implementRevision,
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
            implement,
            implementRevision,
            [address],
          ),
        (error) => error instanceof OperationError && error.code === VALIDATION,
      );
    }
    assert.deepEqual(
      h.service.repositoryBindingIdsOf(tx, h.node_id, FIRST_REVISION),
      [],
    );
    const single: Revision = {
      ...revision,
      revision: FIRST_REVISION + FIRST_REVISION,
      content: { ...revision.content, bindings: [bindingId] },
    };
    insertRevision(tx, single);
    requireTestedInput(tx, h.dependencies.bindings, examine, single, address);
    assert.throws(
      () =>
        requireTestedInput(tx, h.dependencies.bindings, examine, single, [
          address,
        ]),
      (error) => error instanceof OperationError && error.code === VALIDATION,
    );
    const pair: Revision = {
      ...revision,
      revision: FIRST_REVISION + FIRST_REVISION + FIRST_REVISION,
      content: {
        ...revision.content,
        bindings: [otherId, storageId, bindingId],
      },
    };
    insertRevision(tx, pair);
    assert.deepEqual(
      h.service.repositoryBindingIdsOf(tx, h.node_id, pair.revision),
      [otherId, bindingId],
    );
    requireTestedInput(tx, h.dependencies.bindings, examine, pair, [
      { ...address, binding_id: otherId },
      address,
    ]);
    assert.throws(
      () =>
        requireTestedInput(tx, h.dependencies.bindings, examine, pair, [
          address,
        ]),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.EvidenceBindingMismatch,
    );
    assert.throws(
      () =>
        requireTestedInput(tx, h.dependencies.bindings, examine, pair, [
          address,
          { ...address, binding_id: otherId },
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
          examine,
          revision,
          address,
        ),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.EvidenceBindingMismatch,
    );
    assert.equal(implementNodes.length, IMPLEMENT_COUNT);
  });
});

function implementPair(t: TestContext) {
  const h = executionHarness(t, IDENTITY);
  const firstId = createIdentity("binding");
  const secondId = createIdentity("binding");
  h.dependencies.bindings.getBindingRevision = (_tx, id) => ({
    binding_id: id,
    project_id: h.project_id,
    name: id,
    resource_identity: id === secondId ? OTHER_RESOURCE : RESOURCE,
    revision: FIRST_REVISION,
    tombstone: false,
    disabled: false,
  });
  const address = (bindingId: string) =>
    ({
      kind: AssetKind.Repository,
      binding_id: bindingId,
      commit: COMMIT,
    }) as const;
  const check = (testedInput: TestedInput) =>
    h.store.transaction((tx) => {
      const prior = getRevision(tx, h.node_id, FIRST_REVISION);
      const revision: Revision = {
        ...prior,
        content: {
          ...prior.content,
          intent: Intent.Implement,
          bindings: [firstId, secondId],
        },
        tasks: [],
      };
      requireTestedInput(
        tx,
        h.dependencies.bindings,
        readNode(tx, h.node_id)!,
        revision,
        testedInput,
      );
    });
  const mismatch = (bindingId: string) => (error: unknown) =>
    error instanceof OperationError &&
    error.code === MissionErrorCode.EvidenceBindingMismatch &&
    JSON.stringify(error.details) === JSON.stringify({ binding_id: bindingId });
  return { firstId, secondId, address, check, mismatch };
}

test("a node with two bindings writes a tested input list in binding order", (t) => {
  const h = implementPair(t);
  h.check([h.address(h.firstId), h.address(h.secondId)]);
  assert.throws(
    () => h.check(h.address(h.firstId)),
    (error) => error instanceof OperationError && error.code === VALIDATION,
  );
});

test("a list out of binding order answers mission.evidence.binding_mismatch", (t) => {
  const h = implementPair(t);
  const foreignId = createIdentity("binding");
  assert.throws(
    () => h.check([h.address(h.secondId), h.address(h.firstId)]),
    h.mismatch(h.secondId),
  );
  assert.throws(() => h.check([h.address(h.firstId)]), h.mismatch(h.secondId));
  assert.throws(
    () =>
      h.check([
        h.address(h.firstId),
        h.address(h.secondId),
        h.address(foreignId),
      ]),
    h.mismatch(foreignId),
  );
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
    const node = readNode(tx, h.node_id)!;
    revision.content.intent = Intent.Implement;
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
