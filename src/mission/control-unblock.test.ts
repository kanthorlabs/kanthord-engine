import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { MissionErrorCode, NodeKind, NodeState } from "./contract.ts";
import { ControlError } from "./control.ts";
import { openAttempt } from "./record-store.ts";
import {
  insertNode,
  insertDependency,
  setNodeState,
  readCurrentRevision,
} from "./store.ts";
import { controlHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const NO_ATTEMPT = 0;
const NOW = 100;
for (const filenames of [
  ["b.md", "a.md"],
  ["b.md", "c.md"],
]) {
  test(`unblock validates final task names and atomically renames ${filenames.join(",")}`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    const bindingId = createIdentity("binding");
    h.dependencies.bindings.getBindingRevision = () => ({
      binding_id: bindingId,
      project_id: h.project_id,
      name: "repo",
      resource_identity: "repository:github:owner/repo",
      revision: FIRST_ATTEMPT,
      disabled: false,
      tombstone: false,
    });
    h.dependencies.bindings.repositoryPolicyOf = () => ({
      binding_id: bindingId,
      project_id: h.project_id,
      name: "repo",
      address: "git@github.com:owner/repo.git",
      platform: "github",
      ssh_credential: "github-ssh",
      credential: "github",
      base_branch: "main",
      action: null,
      landing: "human",
      project_prompt: null,
    });
    const taskIds = [createIdentity("node"), createIdentity("node")];
    const content = {
      name: "Task",
      requirement: "Requirement",
      criterion: "Criterion",
      verifications: ["true"],
      bindings: [],
    };
    const tasks = taskIds.map((id, index) => ({
      id,
      filename: ["a.md", "b.md"][index]!,
      content,
    }));
    h.dependencies.bindings.resolveBindingIdentity = (_tx, projectId, id) =>
      projectId === h.project_id && id === bindingId
        ? {
            binding_id: bindingId,
            resource_identity: "repository:github:owner/repo",
          }
        : null;
    h.store.transaction((tx) => {
      tx.database
        .prepare("UPDATE mission_node SET kind = ?, state = ? WHERE id = ?")
        .run(NodeKind.Objective, NodeState.Paused, h.node_id);
      for (const task of tasks)
        insertNode(tx, {
          id: task.id,
          mission_id: h.mission_id,
          kind: NodeKind.Task,
          filename: task.filename,
          parent_id: h.node_id,
          created_at: NOW,
        });
      tx.database
        .prepare(
          "UPDATE mission_node_revision SET bindings = ?, tasks = ? WHERE node_id = ?",
        )
        .run(JSON.stringify([bindingId]), JSON.stringify(tasks), h.node_id);
      openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    });
    await h.invoke("node.block", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(NodeState.Paused, FIRST_ATTEMPT),
    });
    const change = {
      content: { ...content, bindings: [bindingId] },
      reason: "Rename",
      tasks: tasks.map((task, index) => ({
        ...task,
        filename: filenames[index]!,
      })),
    };
    const input = {
      params: { node_id: h.node_id },
      query: {},
      body: {
        blocked_attempt: FIRST_ATTEMPT,
        expected_revision: FIRST_ATTEMPT,
        expected_mission_version: FIRST_ATTEMPT,
        change,
      },
    };
    const snapshot = () =>
      h.store.database.prepare("SELECT * FROM mission_node ORDER BY id").all();
    const before = snapshot();
    await assert.rejects(
      h.invoke("node.unblock", {
        ...input,
        body: {
          ...input.body,
          change: {
            ...change,
            tasks: change.tasks.map((task) => ({
              ...task,
              filename: "same.md",
            })),
          },
        },
      }),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.FilenameConflict,
    );
    assert.deepEqual(snapshot(), before);
    assert.equal(
      h.store.transaction((tx) => readCurrentRevision(tx, h.node_id))?.revision,
      FIRST_ATTEMPT,
    );
    const callCount = h.calls.length;
    const insert = h.dependencies.workQueue.insert;
    h.dependencies.workQueue.insert = () => {
      throw new Error("queue write failed");
    };
    await assert.rejects(h.invoke("node.unblock", input), /queue write failed/);
    assert.deepEqual(snapshot(), before);
    assert.equal(
      h.store.transaction((tx) => readCurrentRevision(tx, h.node_id))?.revision,
      FIRST_ATTEMPT,
    );
    assert.equal(h.calls.length, callCount + FIRST_ATTEMPT);
    h.dependencies.workQueue.insert = insert;
    const result = await h.invoke("node.unblock", input);
    assert.equal(result.attempt?.attempt, SECOND_ATTEMPT);
    const row = h.store.transaction((tx) =>
      readCurrentRevision(tx, h.node_id),
    )!;
    assert.deepEqual(
      JSON.parse(row.tasks!)
        .map((task: { filename: string }) => task.filename)
        .sort(),
      [...filenames].sort(),
    );
  });
}
test("objective unblock validates the exact task set and writes the changed task snapshot", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  const taskId = createIdentity("node");
  const content = {
    name: "Task",
    requirement: "Requirement",
    criterion: "Criterion",
    verifications: ["true"],
    bindings: [],
  };
  h.dependencies.bindings.resolveBindingIdentity = (_tx, projectId, id) =>
    projectId === h.project_id && id === bindingId
      ? {
          binding_id: bindingId,
          resource_identity: "repository:github:owner/repo",
        }
      : null;
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET kind = ?, state = ? WHERE id = ?")
      .run(NodeKind.Objective, NodeState.Paused, h.node_id);
    insertNode(tx, {
      id: taskId,
      mission_id: h.mission_id,
      kind: NodeKind.Task,
      filename: "task.md",
      parent_id: h.node_id,
      created_at: NOW,
    });
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ?, tasks = ? WHERE node_id = ?",
      )
      .run(
        JSON.stringify([bindingId]),
        JSON.stringify([{ id: taskId, filename: "task.md", content }]),
        h.node_id,
      );
  });
  await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused),
  });
  const change = {
    content: { ...content, bindings: [bindingId] },
    reason: "Redirect",
    tasks: [
      {
        id: taskId,
        filename: "task.md",
        content: { ...content, criterion: "New criterion" },
      },
    ],
  };
  const input = {
    params: { node_id: h.node_id },
    query: {},
    body: {
      blocked_attempt: NO_ATTEMPT,
      expected_revision: FIRST_ATTEMPT,
      expected_mission_version: FIRST_ATTEMPT,
      change,
    },
  };
  await assert.rejects(
    h.invoke("node.unblock", {
      ...input,
      body: { ...input.body, change: { ...change, tasks: [] } },
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.ContentInvalid,
  );
  await assert.rejects(
    h.invoke("node.unblock", {
      ...input,
      body: {
        ...input.body,
        change: { ...change, content: { ...content, bindings: ["repo"] } },
      },
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.BindingsInvalid &&
      JSON.stringify(error.details) === JSON.stringify({ binding: "repo" }),
  );
  assert.equal(h.node().state, NodeState.Blocked);
  const read = await h.invoke("node.get", {
    params: { node_id: h.node_id },
    query: {},
    body: null,
  });
  assert.deepEqual(read.content.bindings, [bindingId]);
  const result = await h.invoke("node.unblock", {
    ...input,
    body: { ...input.body, change: { ...change, content: read.content } },
  });
  assert.equal(result.node.visible_revision, SECOND_ATTEMPT);
  const stored = h.store.transaction((tx) =>
    readCurrentRevision(tx, h.node_id),
  )!;
  assert.deepEqual(JSON.parse(stored.tasks!), change.tasks);
});
for (const attempt of [NO_ATTEMPT, FIRST_ATTEMPT]) {
  test(`unblock attempt ${attempt} is atomic, preserves zero and rejects retry`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => {
      if (attempt > NO_ATTEMPT)
        openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
      setNodeState(tx, h.node_id, NodeState.Paused);
    });
    await h.invoke("node.block", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(NodeState.Paused, attempt),
    });
    const input = {
      params: { node_id: h.node_id },
      query: {},
      body: {
        blocked_attempt: attempt,
        expected_revision: FIRST_ATTEMPT,
        expected_mission_version: FIRST_ATTEMPT,
      },
    };
    const result = await h.invoke("node.unblock", input);
    assert.equal(
      result.attempt?.attempt ?? NO_ATTEMPT,
      attempt === NO_ATTEMPT ? NO_ATTEMPT : SECOND_ATTEMPT,
    );
    if (result.attempt !== null)
      assert.deepEqual(result.attempt.opened_by, h.actor);
    assert.equal(result.outcome, null);
    await assert.rejects(
      h.invoke("node.unblock", input),
      (error) =>
        error instanceof OperationError &&
        error.code ===
          (attempt === NO_ATTEMPT
            ? ControlError.Refused
            : ControlError.StateConflict),
    );
  });
}

test("unblock checks attempt and revision before changing content; changed content is pinned once", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Paused);
  });
  const blocked = await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused, FIRST_ATTEMPT),
  });
  const body = {
    blocked_attempt: FIRST_ATTEMPT,
    expected_revision: FIRST_ATTEMPT,
    expected_mission_version: FIRST_ATTEMPT,
    change: {
      content: { ...blocked.node.content, name: "New direction" },
      reason: "Redirect",
    },
  };
  const invoke = (changes: Partial<typeof body>) =>
    h.invoke("node.unblock", {
      params: { node_id: h.node_id },
      query: {},
      body: { ...body, ...changes },
    });
  await assert.rejects(
    invoke({ blocked_attempt: NO_ATTEMPT }),
    (error) =>
      error instanceof OperationError &&
      error.code === ControlError.StateConflict,
  );
  await assert.rejects(
    invoke({ expected_revision: SECOND_ATTEMPT }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RevisionConflict,
  );
  const result = await invoke({});
  assert.equal(result.attempt?.node_revision, SECOND_ATTEMPT);
  assert.equal(result.node.visible_revision, SECOND_ATTEMPT);
  const mission = await h.invoke("get", {
    params: { project_id: h.project_id },
    query: {},
    body: null,
  });
  assert.equal(mission.version, SECOND_ATTEMPT);
});

test("unchanged content makes no revision and unsatisfied closure routes unblock to Pending", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const target = createIdentity("node");
  h.store.transaction((tx) => {
    setNodeState(tx, h.node_id, NodeState.Paused);
    insertNode(tx, {
      id: target,
      mission_id: h.mission_id,
      kind: NodeKind.Initiative,
      filename: "target.md",
      parent_id: null,
      created_at: NOW,
    });
    insertDependency(tx, h.mission_id, h.node_id, target);
  });
  const blocked = await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused),
  });
  const result = await h.invoke("node.unblock", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      blocked_attempt: NO_ATTEMPT,
      expected_revision: FIRST_ATTEMPT,
      expected_mission_version: FIRST_ATTEMPT,
      change: { content: blocked.node.content, reason: "Preserve" },
    },
  });
  assert.ok(result.node.kind !== NodeKind.Task);
  assert.equal(result.node.state, NodeState.Pending);
  assert.equal(result.node.visible_revision, FIRST_ATTEMPT);
  assert.equal(
    h.store.transaction((tx) => readCurrentRevision(tx, h.node_id))?.revision,
    FIRST_ATTEMPT,
  );
});

test("unblock accepts an optional nonblank reason and refuses a blank one", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Paused));
  await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused),
  });
  const unblock = (reason: string) =>
    h.invoke("node.unblock", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        blocked_attempt: NO_ATTEMPT,
        expected_revision: FIRST_ATTEMPT,
        expected_mission_version: FIRST_ATTEMPT,
        reason,
      },
    });
  await assert.rejects(unblock(" "), (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, MissionErrorCode.ContentInvalid);
    return true;
  });
  const result = await unblock("Retry on the current base branch.");
  assert.ok(result.node.kind !== NodeKind.Task);
  assert.equal(result.node.state, NodeState.Available);
});
