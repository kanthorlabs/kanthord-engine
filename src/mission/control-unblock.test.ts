import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { Intent, MissionErrorCode, NodeState, TaskChange } from "./contract.ts";
import { Act, ActAttribute } from "./act-telemetry.ts";
import { ControlError } from "./control.ts";
import { openAttempt } from "./record-store.ts";
import {
  insertDependency,
  insertNode,
  readCurrentRevision,
  setNodeState,
} from "./store.ts";
import { actCalls, controlHarness, settlesExpired } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const NO_ATTEMPT = 0;
const NOW = 100;
const ADDED_TASK_FILE = "added.md";
const EXECUTIONS_LOST = "schedulerClaims.executionsLost";
const NO_ACTS = 0;
const ONE_ACT = 1;
const REDIRECT_ACTS = 3;
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
    });
    const taskIds = [createIdentity("task"), createIdentity("task")];
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
        .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
        .run(NodeState.Paused, h.node_id);
      tx.database
        .prepare(
          "UPDATE mission_node_revision SET intent = ? WHERE node_id = ?",
        )
        .run(Intent.Implement, h.node_id);
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
      content: { ...content, intent: Intent.Implement, bindings: [bindingId] },
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
test("implement unblock refuses a task of another set and writes the changed task snapshot", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  const taskId = createIdentity("task");
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
  h.dependencies.bindings.getBindingRevision = () => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: "repo",
    resource_identity: "repository:github:owner/repo",
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
      .run(NodeState.Paused, h.node_id);
    tx.database
      .prepare("UPDATE mission_node_revision SET intent = ? WHERE node_id = ?")
      .run(Intent.Implement, h.node_id);
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
    content: { ...content, intent: Intent.Implement, bindings: [bindingId] },
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
      body: {
        ...input.body,
        change: {
          ...change,
          tasks: [{ ...change.tasks[0]!, id: createIdentity("task") }],
        },
      },
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
        change: {
          ...change,
          content: { ...content, intent: Intent.Implement, bindings: ["repo"] },
        },
      },
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.BindingsInvalid &&
      JSON.stringify(error.details) === JSON.stringify({ binding: "repo" }),
  );
  const task = change.tasks[0]!;
  await assert.rejects(
    h.invoke("node.unblock", {
      ...input,
      body: {
        ...input.body,
        change: {
          ...change,
          tasks: [
            { ...task, content: { ...task.content, bindings: [bindingId] } },
          ],
        },
      },
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.BindingsInvalid &&
      JSON.stringify(error.details) ===
        JSON.stringify({ filename: task.filename }),
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
      tasks: [],
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

test("a node update keeps the open attempt on its revision, and unblock pins the updated revision", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Paused);
  });
  const read = () =>
    h.invoke("node.get", {
      params: { node_id: h.node_id },
      query: {},
      body: null,
    });
  const before = await read();
  await h.invoke("node.update", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      filename: before.filename,
      content: { ...before.content, name: "New direction" },
      tasks: [],
      reason: "Redirect",
      expected_revision: FIRST_ATTEMPT,
      expected_mission_version: FIRST_ATTEMPT,
    },
  });
  const updated = await read();
  assert.equal(updated.visible_revision, SECOND_ATTEMPT);
  assert.equal(updated.pinned_revision, FIRST_ATTEMPT);
  const blocked = await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.body(NodeState.Paused, FIRST_ATTEMPT),
      expected_mission_version: SECOND_ATTEMPT,
    },
  });
  assert.equal(blocked.node.pinned_revision, null);
  const result = await h.invoke("node.unblock", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      blocked_attempt: FIRST_ATTEMPT,
      expected_revision: updated.visible_revision,
      expected_mission_version: SECOND_ATTEMPT,
    },
  });
  assert.equal(result.attempt?.attempt, SECOND_ATTEMPT);
  assert.equal(result.attempt?.node_revision, SECOND_ATTEMPT);
  assert.equal(result.node.pinned_revision, result.node.visible_revision);
});

test("unchanged content makes no revision and unsatisfied closure routes unblock to Pending", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const target = createIdentity("node");
  h.store.transaction((tx) => {
    setNodeState(tx, h.node_id, NodeState.Paused);
    insertNode(tx, {
      id: target,
      mission_id: h.mission_id,
      filename: "target.md",
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
      change: {
        content: blocked.node.content,
        tasks: [],
        reason: "Preserve",
      },
    },
  });
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
  assert.equal(result.node.state, NodeState.Available);
});

test("an unblock that settles an expired execution inline writes one lost end after its commit", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const executionId = createIdentity("execution");
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Paused));
  await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused),
  });
  settlesExpired(h.dependencies, executionId);
  const unblock = (attempt: number) =>
    h.invoke("node.unblock", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        blocked_attempt: attempt,
        expected_revision: FIRST_ATTEMPT,
        expected_mission_version: FIRST_ATTEMPT,
      },
    });
  await assert.rejects(
    unblock(SECOND_ATTEMPT),
    (error) =>
      error instanceof OperationError &&
      error.code === ControlError.StateConflict,
  );
  assert.equal(
    h.calls.some((call) => call.method === EXECUTIONS_LOST),
    false,
  );
  await unblock(NO_ATTEMPT);
  const ends = h.calls.filter((call) => call.method === EXECUTIONS_LOST);
  assert.equal(ends.length, FIRST_ATTEMPT);
  const [lost] = ends[0]!.arguments as [{ execution_id: string }[]];
  assert.deepEqual(
    lost.map((execution) => execution.execution_id),
    [executionId],
  );
});

test("unblock change adds and removes a task", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  const kept = createIdentity("task");
  const removed = createIdentity("task");
  const content = {
    name: "Name",
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
  h.dependencies.bindings.getBindingRevision = () => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: "repo",
    resource_identity: "repository:github:owner/repo",
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
      .run(NodeState.Paused, h.node_id);
    tx.database
      .prepare("UPDATE mission_node_revision SET intent = ? WHERE node_id = ?")
      .run(Intent.Implement, h.node_id);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ?, tasks = ? WHERE node_id = ?",
      )
      .run(
        JSON.stringify([bindingId]),
        JSON.stringify([
          { id: kept, filename: "kept.md", content },
          { id: removed, filename: "removed.md", content },
        ]),
        h.node_id,
      );
  });
  await h.invoke("node.block", {
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
      change: {
        content: {
          ...content,
          intent: Intent.Implement,
          bindings: [bindingId],
        },
        tasks: [
          { id: kept, filename: "kept.md", content },
          { filename: ADDED_TASK_FILE, content },
        ],
        reason: "Redirect",
      },
    },
  });
  assert.equal(result.node.visible_revision, SECOND_ATTEMPT);
  const revision = await h.invoke("node.revision.get", {
    params: { node_id: h.node_id, revision: String(SECOND_ATTEMPT) },
    query: {},
    body: null,
  });
  const added = revision.tasks.find(
    (task) => task.filename === ADDED_TASK_FILE,
  );
  assert.ok(added);
  assert.match(added.id, /^task_/);
  assert.deepEqual(
    revision.tasks.map((task) => task.id),
    [kept, added.id],
  );
  assert.deepEqual(revision.change.changed_fields, ["tasks"]);
  assert.deepEqual(revision.change.tasks, [
    {
      id: added.id,
      change: TaskChange.Created,
      changed_fields: [
        "filename",
        "name",
        "requirement",
        "criterion",
        "verifications",
        "bindings",
      ],
    },
    { id: removed, change: TaskChange.Retired, changed_fields: [] },
  ]);
  assert.deepEqual(result.node.tasks, revision.tasks);
});

test("unblock refuses an intent change after the first claim with mission.node.intent_locked", async (t) => {
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
  });
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
      .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
      .run(NodeState.Paused, h.node_id);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET intent = ?, bindings = ? WHERE node_id = ?",
      )
      .run(Intent.Implement, JSON.stringify([bindingId]), h.node_id);
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
  });
  await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused, FIRST_ATTEMPT),
  });
  const snapshot = () =>
    h.store.database.prepare("SELECT * FROM mission_node ORDER BY id").all();
  const before = snapshot();
  await assert.rejects(
    h.invoke("node.unblock", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        blocked_attempt: FIRST_ATTEMPT,
        expected_revision: FIRST_ATTEMPT,
        expected_mission_version: FIRST_ATTEMPT,
        change: {
          content: {
            ...content,
            intent: Intent.Examine,
            bindings: [bindingId],
          },
          tasks: [],
          reason: "Redirect",
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.Conflict);
      assert.equal(error.code, MissionErrorCode.IntentLocked);
      assert.deepEqual(error.details, {
        node_id: h.node_id,
        attempt: FIRST_ATTEMPT,
      });
      return true;
    },
  );
  assert.deepEqual(snapshot(), before);
  assert.equal(h.node().state, NodeState.Blocked);
  assert.equal(
    h.store.transaction((tx) => readCurrentRevision(tx, h.node_id))?.revision,
    FIRST_ATTEMPT,
  );
});

test("unblock with a change that names mixed environments refuses and keeps the node blocked", async (t) => {
  const first = createIdentity("binding");
  const second = createIdentity("binding");
  const identities = new Map([
    [first, "repository:github:owner/first"],
    [second, "repository:github:owner/second"],
  ]);
  const h = controlHarness(t, IDENTITY, {
    environments: {
      environmentsMixed: (_tx, _projectId, resourceIdentities) =>
        resourceIdentities.length === identities.size,
    },
  });
  h.dependencies.bindings.resolveBindingIdentity = (_tx, projectId, id) =>
    projectId === h.project_id && identities.has(id)
      ? { binding_id: id, resource_identity: identities.get(id)! }
      : null;
  h.dependencies.bindings.getBindingRevision = (_tx, id) => ({
    binding_id: id,
    project_id: h.project_id,
    name: id,
    resource_identity: identities.get(id)!,
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
      .run(NodeState.Paused, h.node_id),
  );
  await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused),
  });
  const revisions = () =>
    h.store.database.prepare("SELECT * FROM mission_node_revision").all();
  const before = revisions();
  await assert.rejects(
    h.invoke("node.unblock", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        blocked_attempt: NO_ATTEMPT,
        expected_revision: FIRST_ATTEMPT,
        expected_mission_version: FIRST_ATTEMPT,
        change: {
          content: {
            name: "Name",
            requirement: "Requirement",
            criterion: "Criterion",
            verifications: ["true"],
            bindings: [first, second],
            intent: Intent.Implement,
          },
          tasks: [],
          reason: "Redirect",
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.BadRequest);
      assert.equal(error.code, MissionErrorCode.EnvironmentMixed);
      assert.deepEqual(error.details, { bindings: [first, second] });
      return true;
    },
  );
  assert.deepEqual(revisions(), before);
  const node = await h.invoke("node.get", {
    params: { node_id: h.node_id },
    query: {},
    body: null,
  });
  assert.equal(node.state, NodeState.Blocked);
});

test("an unblock writes one act trace with the attempt that it opens and its reason", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Paused);
  });
  await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused, FIRST_ATTEMPT),
  });
  const statesAtAct: (NodeState | null)[] = [];
  h.dependencies.acts.act = (...args) => {
    statesAtAct.push(h.node().state);
    h.calls.push({ method: "acts.act", arguments: args });
  };
  await h.invoke("node.unblock", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      blocked_attempt: FIRST_ATTEMPT,
      expected_revision: FIRST_ATTEMPT,
      expected_mission_version: FIRST_ATTEMPT,
      reason: "Retry on the current base branch.",
    },
  });
  const written = actCalls(h).filter(
    ([, contribution]) => contribution.operation === Act.Unblock,
  );
  assert.equal(written.length, ONE_ACT);
  assert.deepEqual(statesAtAct, [NodeState.Available]);
  const [trace, contribution] = written[0]!;
  assert.equal(
    contribution.attributes[ActAttribute.MissionVersion],
    FIRST_ATTEMPT,
  );
  assert.equal(contribution.operation, Act.Unblock);
  assert.equal(trace.node_id, h.node_id);
  assert.equal(trace.attempt, SECOND_ATTEMPT);
  assert.equal(contribution.attributes[ActAttribute.Attempt], SECOND_ATTEMPT);
  assert.equal(
    contribution.attributes[ActAttribute.StateFrom],
    NodeState.Blocked,
  );
  assert.equal(
    contribution.attributes[ActAttribute.StateTo],
    NodeState.Available,
  );
  assert.deepEqual(contribution.texts, [
    {
      text_id: `${trace.root_span_id}:reason`,
      text: "Retry on the current base branch.",
    },
  ]);
});

test("an unblock without a reason writes an act trace without a text", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Blocked));
  await h.invoke("node.unblock", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      blocked_attempt: NO_ATTEMPT,
      expected_revision: FIRST_ATTEMPT,
      expected_mission_version: FIRST_ATTEMPT,
    },
  });
  const [trace, contribution] = actCalls(h)[0]!;
  assert.equal(trace.attempt, null);
  assert.equal(contribution.texts, undefined);
});

test("a redirect writes the pause, the block and the unblock acts in that order", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Waiting);
  });
  const paused = await h.invoke("node.pause", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Waiting, FIRST_ATTEMPT),
  });
  await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused, FIRST_ATTEMPT),
  });
  await h.invoke("node.unblock", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      blocked_attempt: FIRST_ATTEMPT,
      expected_revision: FIRST_ATTEMPT,
      expected_mission_version: FIRST_ATTEMPT,
      change: {
        content: { ...paused.node.content, name: "New direction" },
        tasks: [],
        reason: "Redirect",
      },
    },
  });
  const written = actCalls(h);
  assert.equal(written.length, REDIRECT_ACTS);
  assert.deepEqual(
    written.map(([, contribution]) => contribution.operation),
    [Act.Pause, Act.Block, Act.Unblock],
  );
});

test("a refused unblock writes no act trace", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Paused));
  await assert.rejects(
    h.invoke("node.unblock", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        blocked_attempt: NO_ATTEMPT,
        expected_revision: FIRST_ATTEMPT,
        expected_mission_version: FIRST_ATTEMPT,
      },
    }),
    (error) =>
      error instanceof OperationError && error.code === ControlError.Refused,
  );
  assert.equal(actCalls(h).length, NO_ACTS);
});
