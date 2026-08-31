import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { eventRow } from "../../domain/event.ts";
import { nodeRow } from "../../domain/node.ts";
import { canTransition } from "../../domain/transition.ts";
import type { RecoveryFinding } from "../../domain/recovery.ts";
import { GitError, type Git } from "../../services/git/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { SetNodeStateInput } from "../../services/plan/index.ts";
import type { Transaction } from "../../services/storage/index.ts";
import { createRecoveryFixture } from "../../../test/helpers/recovery.ts";
import type { RecoveryFixture } from "../../../test/helpers/recovery.ts";
import {
  createPlanStore,
  createReadiness,
} from "../../../test/helpers/plan.ts";
import {
  createBackedExecutionFake,
  createExecutionFake,
  type ExecutionFake,
} from "../../../test/helpers/execution.ts";
import type { Execution } from "../../services/execution/index.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import {
  createLeaseFake,
  type LeaseFake,
} from "../../../test/helpers/lease.ts";
import { lintCase } from "../../../test/helpers/lint.ts";
import {
  seedExecution,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import {
  recoverExpiredLeases,
  sweepExpiredExternalLeases,
  type RecoverExpiredLeasesResult,
  type SweepExpiredExternalLeasesResult,
} from "./recover-expired-leases.ts";

const ACTOR = "daemon-startup";
const BASE = "a".repeat(40);
const OTHER = "b".repeat(40);
const NOW = 1700000000000;
const EXPIRED = 1699999999999;

const TASK_A = "task_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TASK_B = "task_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TASK_C = "task_01ARZ3NDEKTSV4RRFFQ69G5FAX";

const INSTRUCTION_BLOB = `sha256:${"0".repeat(64)}`;
const ACCEPTANCE_BLOB = `sha256:${"1".repeat(64)}`;
const PROFILE_BLOB = `sha256:${"2".repeat(64)}`;

type MockConfig = Readonly<{
  clean?: boolean;
  head?: string | null;
  worktreeError?: unknown;
  onWorktreeClean?: (workDir: string) => void;
}>;

type Mock = Readonly<{
  git: Git;
  worktreeCalls: readonly string[];
  headCalls: readonly { gitDir: string; ref: string }[];
}>;

function gitMock(config: MockConfig): Mock {
  const worktreeCalls: string[] = [];
  const headCalls: { gitDir: string; ref: string }[] = [];
  const git = {
    remoteUrlVerdict(): never {
      throw new Error("unexpected remoteUrlVerdict call");
    },
    scanHostKeys(): Promise<never> {
      throw new Error("unexpected scanHostKeys call");
    },
    confirmHostKey(): Promise<never> {
      throw new Error("unexpected confirmHostKey call");
    },
    trustHostKey(): Promise<never> {
      throw new Error("unexpected trustHostKey call");
    },
    seedHome(): Promise<never> {
      throw new Error("unexpected seedHome call");
    },
    remoteInfo(): Promise<never> {
      throw new Error("unexpected remoteInfo call");
    },
    canPush(): Promise<never> {
      throw new Error("unexpected canPush call");
    },
    probePush(): Promise<never> {
      throw new Error("unexpected probePush call");
    },
    fetch(): Promise<never> {
      throw new Error("unexpected fetch call");
    },
    async resolveRef(
      input: Readonly<{ gitDir: string; ref: string }>,
    ): Promise<string | null> {
      headCalls.push(input);
      return config.head ?? BASE;
    },
    refUpdate(): Promise<never> {
      throw new Error("unexpected refUpdate call");
    },
    checkOutsideWriter(): Promise<never> {
      throw new Error("unexpected checkOutsideWriter call");
    },
    clone(): Promise<never> {
      throw new Error("unexpected clone call");
    },
    inspectChild(): Promise<never> {
      throw new Error("unexpected inspectChild call");
    },
    stopChild(): Promise<never> {
      throw new Error("unexpected stopChild call");
    },
    listPidFiles(): Promise<never> {
      throw new Error("unexpected listPidFiles call");
    },
    removePidFile(): Promise<never> {
      throw new Error("unexpected removePidFile call");
    },
    sweepHome(): Promise<never> {
      throw new Error("unexpected sweepHome call");
    },
    async worktreeClean(
      input: Readonly<{ workDir: string }>,
    ): Promise<boolean> {
      worktreeCalls.push(input.workDir);
      config.onWorktreeClean?.(input.workDir);
      if (config.worktreeError !== undefined) {
        throw config.worktreeError;
      }
      return config.clean ?? true;
    },
  };
  return { git, worktreeCalls, headCalls };
}

function seedBase(t: { after(fn: () => void): void }): RecoveryFixture {
  const fixture = createRecoveryFixture();
  t.after(() => fixture.dispose());
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedExecution(transaction);
  });
  return fixture;
}

function insertTask(fixture: RecoveryFixture, id: string, state: string): void {
  const ulid = id.slice(id.indexOf("_") + 1);
  const projectId = `project_${ulid}`;
  const revisionId = `revision_${ulid}`;
  const repositoryId = `repo_${ulid}`;
  const initiativeId = `initiative_${ulid}`;
  const objectiveId = `objective_${ulid}`;
  fixture.storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
      [projectId, `project-${ulid}`, "general@1", null, NOW],
    );
    transaction.run(
      "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)",
      [
        revisionId,
        projectId,
        null,
        "import_a",
        INSTRUCTION_BLOB,
        INSTRUCTION_BLOB,
        INSTRUCTION_BLOB,
      ],
    );
    transaction.run(
      "INSERT INTO repository (id, name, remote_url, credential_id, home_path, branch, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        repositoryId,
        `repo-${ulid}`,
        "https://example.invalid/fixture.git",
        "provider_a",
        "repos/fixture.git",
        "main",
        0,
        "ready",
        null,
        null,
        null,
        NOW,
      ],
    );
    transaction.run(
      "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        initiativeId,
        projectId,
        "initiative",
        null,
        "fixture initiative",
        INSTRUCTION_BLOB,
        null,
        null,
        null,
        "ready",
        null,
        null,
        revisionId,
        NOW,
      ],
    );
    transaction.run(
      "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        objectiveId,
        projectId,
        "objective",
        initiativeId,
        "fixture objective",
        INSTRUCTION_BLOB,
        null,
        null,
        repositoryId,
        "ready",
        null,
        null,
        revisionId,
        NOW,
      ],
    );
    transaction.run(
      "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        projectId,
        "task",
        objectiveId,
        "fixture task",
        INSTRUCTION_BLOB,
        ACCEPTANCE_BLOB,
        null,
        null,
        state,
        null,
        null,
        revisionId,
        NOW,
      ],
    );
  });
}

function insertWorkspace(
  fixture: RecoveryFixture,
  id: string,
  path: string,
  nodeId = "objective_a",
): void {
  fixture.storage.transact((transaction) => {
    const taken = transaction.get(
      "SELECT id FROM workspace WHERE node_id = ?",
      [nodeId],
    );
    if (taken !== undefined) {
      transaction.run("DELETE FROM attempt WHERE run_id = 'run_b'");
      transaction.run("DELETE FROM run WHERE id IN ('run_a', 'run_b')");
      transaction.run("DELETE FROM workspace WHERE node_id = ?", [nodeId]);
    }
    transaction.run(
      "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        nodeId,
        "repo_a",
        path,
        BASE,
        BASE,
        PROFILE_BLOB,
        "coding/v1",
        null,
        "ready",
        NOW,
      ],
    );
    if (taken !== undefined) {
      transaction.run(
        "INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "run_a",
          "objective",
          "objective_a",
          null,
          id,
          "general@1",
          1,
          3,
          BASE,
          null,
          "active",
          null,
          null,
        ],
      );
    }
  });
}

function insertRun(
  fixture: RecoveryFixture,
  id: string,
  nodeId: string,
  workspaceId: string,
  state = "active",
): void {
  fixture.storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        "task",
        nodeId,
        "run_a",
        workspaceId,
        "general@1",
        1,
        3,
        BASE,
        null,
        state,
        null,
        null,
      ],
    );
  });
}

function insertLease(
  fixture: RecoveryFixture,
  subjectId: string,
  expiresAt: number | null,
): void {
  fixture.storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO lease (subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, ?, ?, ?, ?, ?)",
      [subjectId, null, 1, null, null, expiresAt],
    );
  });
}

function insertHeldLease(
  fixture: RecoveryFixture,
  input: Readonly<{
    subjectId: string;
    owner: string;
    fence: number;
    expiresAt: number;
  }>,
): void {
  fixture.storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, ?, 'actor', ?, ?, ?, ?)",
      [
        input.subjectId,
        input.owner,
        input.fence,
        EXPIRED,
        EXPIRED,
        input.expiresAt,
      ],
    );
  });
}

function insertExternalRun(
  fixture: RecoveryFixture,
  input: Readonly<{
    id: string;
    kind: "objective" | "task";
    nodeId: string;
    parentRunId: string | null;
    fence: number;
  }>,
): void {
  fixture.storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, 'external', NULL, NULL, ?, 3, NULL, NULL, 'active', NULL, NULL)",
      [input.id, input.kind, input.nodeId, input.parentRunId, input.fence],
    );
  });
}

function insertExternalAttempt(
  fixture: RecoveryFixture,
  input: Readonly<{ id: string; runId: string }>,
): void {
  fixture.storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, 'external', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
      [input.id, input.runId],
    );
  });
}

const ulidOf = (id: string): string => id.slice(id.indexOf("_") + 1);

const runIdFor = (kind: "objective" | "task", id: string): string =>
  `run_ext_${kind}_${ulidOf(id)}`;

const attemptIdFor = (id: string): string => `attempt_ext_${ulidOf(id)}`;

function seedExternalTaskClaim(
  t: { after(fn: () => void): void },
  taskId: string,
): Readonly<{
  fixture: RecoveryFixture;
  runId: string;
  attemptId: string;
  executionFake: ExecutionFake;
  leaseFake: LeaseFake;
  recording: ReturnType<typeof recordingPlanStore>;
  mock: Mock;
}> {
  const fixture = seedTaskFixture(t, taskId);
  const objectiveId = `objective_${ulidOf(taskId)}`;
  const runId = runIdFor("task", taskId);
  const attemptId = attemptIdFor(taskId);
  insertExternalRun(fixture, {
    id: runIdFor("objective", objectiveId),
    kind: "objective",
    nodeId: objectiveId,
    parentRunId: null,
    fence: 5,
  });
  insertExternalRun(fixture, {
    id: runId,
    kind: "task",
    nodeId: taskId,
    parentRunId: runIdFor("objective", objectiveId),
    fence: 5,
  });
  insertExternalAttempt(fixture, { id: attemptId, runId });
  insertHeldLease(fixture, {
    subjectId: taskId,
    owner: "actor_harness",
    fence: 5,
    expiresAt: EXPIRED,
  });
  const executionFake = createExecutionFake();
  executionFake.attemptsByRun.set(runId, [
    {
      id: attemptId,
      runId,
      driver: "external",
      attemptNo: 1,
      headOid: null,
      outcome: null,
      endedAt: null,
    },
  ]);
  const recording = recordingPlanStore(
    createPlanStore(createReadiness(fixture.events, "daemon_test")),
  );
  const leaseFake = createLeaseFake();
  const mock = gitMock({});
  return {
    fixture,
    runId,
    attemptId,
    executionFake,
    leaseFake,
    recording,
    mock,
  };
}

function seedExternalObjectiveClaim(
  t: { after(fn: () => void): void },
  taskId: string,
): Readonly<{
  fixture: RecoveryFixture;
  objectiveId: string;
  runId: string;
  executionFake: ExecutionFake;
  leaseFake: LeaseFake;
  recording: ReturnType<typeof recordingPlanStore>;
  mock: Mock;
}> {
  const fixture = seedTaskFixture(t, taskId);
  const objectiveId = `objective_${ulidOf(taskId)}`;
  fixture.storage.transact((transaction) => {
    transaction.run("UPDATE node SET state = 'running' WHERE id = ?", [
      objectiveId,
    ]);
  });
  const runId = runIdFor("objective", objectiveId);
  insertExternalRun(fixture, {
    id: runId,
    kind: "objective",
    nodeId: objectiveId,
    parentRunId: null,
    fence: 3,
  });
  insertHeldLease(fixture, {
    subjectId: objectiveId,
    owner: "actor_harness",
    fence: 3,
    expiresAt: EXPIRED,
  });
  const executionFake = createExecutionFake();
  const recording = recordingPlanStore(
    createPlanStore(createReadiness(fixture.events, "daemon_test")),
  );
  const leaseFake = createLeaseFake();
  const mock = gitMock({});
  return {
    fixture,
    objectiveId,
    runId,
    executionFake,
    leaseFake,
    recording,
    mock,
  };
}

function seedTaskFixture(
  t: { after(fn: () => void): void },
  taskId: string,
  state = "running",
): RecoveryFixture {
  const fixture = seedBase(t);
  insertTask(fixture, taskId, state);
  return fixture;
}

async function runRecover(
  fixture: RecoveryFixture,
  mock: Mock,
  plan: PlanStore = createPlanStore(
    createReadiness(fixture.events, "daemon_test"),
  ),
  execution: Execution = createExecutionFake().execution,
  leaseFake: LeaseFake = createLeaseFake(),
): Promise<RecoverExpiredLeasesResult> {
  return recoverExpiredLeases(
    {
      storage: fixture.storage,
      plan,
      git: mock.git,
      lease: leaseFake.lease,
      execution,
      events: fixture.events,
      clock: fixture.clock,
    },
    { actor: ACTOR },
  );
}

function recordingPlanStore(plan: PlanStore): Readonly<{
  plan: PlanStore;
  setNodeStateInputs: readonly SetNodeStateInput[];
  setNodeStateResults: readonly unknown[][];
}> {
  const setNodeStateInputs: SetNodeStateInput[] = [];
  const setNodeStateResults: unknown[][] = [];
  const recording: PlanStore = new Proxy(plan, {
    get(target, property, receiver) {
      if (property === "setNodeState") {
        return (
          transaction: Transaction,
          input: SetNodeStateInput,
        ): readonly unknown[] => {
          setNodeStateInputs.push(input);
          const result = target.setNodeState(transaction, input);
          setNodeStateResults.push([...result]);
          return result;
        };
      }
      return Reflect.get(target, property, target);
    },
  });
  return { plan: recording, setNodeStateInputs, setNodeStateResults };
}

function readNode(
  fixture: RecoveryFixture,
  id: string,
): Readonly<Record<string, unknown>> {
  const row = fixture.storage.transact((transaction) =>
    transaction.get("SELECT state, block_reason FROM node WHERE id = ?", [id]),
  ) as Readonly<Record<string, unknown>>;
  return { ...row };
}

function readLease(
  fixture: RecoveryFixture,
  subjectId: string,
): Readonly<Record<string, unknown>> {
  const row = fixture.storage.transact((transaction) =>
    transaction.get(
      "SELECT owner, expires_at, renewed_at, fence FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
      [subjectId],
    ),
  ) as Readonly<Record<string, unknown>>;
  return { ...row };
}

function readLeaseRow(
  fixture: RecoveryFixture,
  subjectId: string,
): Readonly<Record<string, unknown>> {
  const row = fixture.storage.transact((transaction) =>
    transaction.get(
      "SELECT subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
      [subjectId],
    ),
  ) as Readonly<Record<string, unknown>>;
  return { ...row };
}

function parseEvent(
  event: Readonly<{
    id: string;
    subjectKind: string;
    subjectId: string;
    type: string;
    actorKind: "human" | "daemon" | "harness";
    actorId: string;
    payload: unknown;
  }>,
): void {
  assert.doesNotThrow(() =>
    eventRow.parse({
      id: event.id,
      subjectKind: event.subjectKind,
      subjectId: event.subjectId,
      type: event.type,
      actorKind: event.actorKind,
      actorId: event.actorId,
      payloadJson: JSON.stringify(event.payload),
    }),
  );
}

function parseNode(fixture: RecoveryFixture, id: string): void {
  const row = fixture.storage.transact((transaction) =>
    transaction.get("SELECT * FROM node WHERE id = ?", [id]),
  ) as Readonly<Record<string, unknown>>;
  assert.doesNotThrow(() =>
    nodeRow.parse({
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      parentId: row.parent_id,
      title: row.title,
      instructionBlob: row.instruction_blob,
      acceptanceBlob: row.acceptance_blob,
      worker: row.worker,
      repositoryId: row.repository_id,
      state: row.state,
      blockReason: row.block_reason,
      discardReason: row.discard_reason,
      revision: row.revision,
      updatedAt: row.updated_at,
      deliverable: row.deliverable,
      verifyJson: row.verify_json,
    }),
  );
}

describe("src/commands/startup/recover-expired-leases.test", () => {
  it("an expired lease on a clean workspace at the recorded base returns the node to ready", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, EXPIRED);
    const mock = gitMock({ clean: true, head: BASE });
    const result = await runRecover(fixture, mock);
    assert.equal(result.returnedToReady, 1);
    assert.equal(result.blocked, 0);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "ready",
      block_reason: null,
    });
    assert.deepEqual(readLease(fixture, TASK_A), {
      owner: null,
      expires_at: null,
      renewed_at: null,
      fence: 1,
    });
    parseNode(fixture, TASK_A);
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "recovery.leaseRecovered");
    assert.equal(events[0]!.subjectKind, "node");
    assert.equal(events[0]!.subjectId, TASK_A);
    assert.equal(events[0]!.actorKind, "daemon");
    assert.equal(events[0]!.actorId, ACTOR);
    assert.deepEqual(events[0]!.payload, {
      target: "ready",
      clean: true,
      headOid: BASE,
      baseOid: BASE,
      fence: 1,
    });
    parseEvent(events[0]!);
  });

  it("an expired lease on a dirty workspace moves the node to blocked with reason dirty-recovery", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, EXPIRED);
    const mock = gitMock({ clean: false, head: BASE });
    const result = await runRecover(fixture, mock);
    assert.equal(result.blocked, 1);
    assert.equal(result.returnedToReady, 0);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "blocked",
      block_reason: "dirty-recovery",
    });
    assert.deepEqual(readLease(fixture, TASK_A), {
      owner: null,
      expires_at: null,
      renewed_at: null,
      fence: 1,
    });
    parseNode(fixture, TASK_A);
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "recovery.leaseBlocked");
    assert.deepEqual(events[0]!.payload, {
      target: "blocked",
      clean: false,
      headOid: BASE,
      baseOid: BASE,
      fence: 1,
    });
    parseEvent(events[0]!);
  });

  it("a clean workspace whose head differs from the recorded base moves to blocked", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, EXPIRED);
    const mock = gitMock({ clean: true, head: OTHER });
    const result = await runRecover(fixture, mock);
    assert.equal(result.blocked, 1);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "blocked",
      block_reason: "dirty-recovery",
    });
    assert.equal(fixture.listEvents()[0]!.type, "recovery.leaseBlocked");
    assert.deepEqual(fixture.listEvents()[0]!.payload, {
      target: "blocked",
      clean: true,
      headOid: OTHER,
      baseOid: BASE,
      fence: 1,
    });
  });

  it("a lease expiring one millisecond after the mock's instant is not a candidate", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, NOW + 1);
    const mock = gitMock({});
    const result = await runRecover(fixture, mock);
    assert.equal(result.returnedToReady, 0);
    assert.equal(result.blocked, 0);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "running",
      block_reason: null,
    });
    assert.equal(fixture.listEvents().length, 0);
    assert.deepEqual(mock.worktreeCalls, []);
  });

  it("a lease expiring exactly at the mock's instant is a candidate", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, NOW);
    const mock = gitMock({ clean: true, head: BASE });
    const result = await runRecover(fixture, mock);
    assert.equal(result.returnedToReady, 1);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "ready",
      block_reason: null,
    });
  });

  it("a lease with a null expiry is not a candidate", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, null);
    const mock = gitMock({});
    const result = await runRecover(fixture, mock);
    assert.equal(result.returnedToReady, 0);
    assert.equal(result.blocked, 0);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "running",
      block_reason: null,
    });
    assert.equal(fixture.listEvents().length, 0);
  });

  it("a ready node with an expired lease is not a candidate", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A, "ready");
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, EXPIRED);
    const mock = gitMock({});
    const result = await runRecover(fixture, mock);
    assert.equal(result.returnedToReady, 0);
    assert.equal(result.blocked, 0);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "ready",
      block_reason: null,
    });
    assert.equal(fixture.listEvents().length, 0);
  });

  it("an internal non-task lease still emits lease-expired-on-non-task", async (t) => {
    const fixture = seedBase(t);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "UPDATE node SET state = 'running' WHERE id = 'objective_a'",
      );
      transaction.run(
        "INSERT INTO lease (subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at) VALUES ('node', 'objective_a', ?, ?, ?, ?, ?)",
        [null, 1, null, null, EXPIRED],
      );
    });
    const mock = gitMock({});
    const result = await runRecover(fixture, mock);
    assert.equal(result.returnedToReady, 0);
    assert.equal(result.blocked, 0);
    assert.equal(result.findings.length, 1);
    const finding = result.findings[0] as RecoveryFinding;
    assert.equal(finding.step, "leases");
    assert.equal(finding.code, "lease-expired-on-non-task");
    const node = fixture.storage.transact((transaction) =>
      transaction.get("SELECT state FROM node WHERE id = 'objective_a'"),
    ) as { state: string };
    assert.equal(node.state, "running");
    assert.equal(fixture.listEvents().length, 0);
    const lease = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT fence FROM lease WHERE subject_kind = 'node' AND subject_id = 'objective_a'",
      ),
    ) as { fence: number };
    assert.equal(lease.fence, 1);
    assert.deepEqual(mock.worktreeCalls, []);
  });

  it("a task with no run and no workspace moves to blocked with recovery-inputs-missing", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertLease(fixture, TASK_A, EXPIRED);
    const mock = gitMock({});
    const result = await runRecover(fixture, mock);
    assert.equal(result.blocked, 1);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "blocked",
      block_reason: "dirty-recovery",
    });
    assert.equal(result.findings.length, 1);
    const finding = result.findings[0] as RecoveryFinding;
    assert.equal(finding.step, "leases");
    assert.equal(finding.code, "recovery-inputs-missing");
    assert.deepEqual(mock.worktreeCalls, []);
    assert.deepEqual(mock.headCalls, []);
  });

  it("a task whose only run row has state ended reaches the same blocked outcome", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "ended",
    );
    insertLease(fixture, TASK_A, EXPIRED);
    const mock = gitMock({});
    const result = await runRecover(fixture, mock);
    assert.equal(result.blocked, 1);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "blocked",
      block_reason: "dirty-recovery",
    });
    assert.equal(result.findings[0]!.code, "recovery-inputs-missing");
    assert.deepEqual(mock.worktreeCalls, []);
  });

  it("a task whose active run names the objective's workspace is recovered through run.workspace_id", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, EXPIRED);
    const mock = gitMock({ clean: true, head: BASE });
    const result = await runRecover(fixture, mock);
    assert.equal(result.returnedToReady, 1);
    assert.deepEqual(mock.worktreeCalls, ["workspaces/task-a"]);
    assert.deepEqual(mock.headCalls, [
      { gitDir: "workspaces/task-a/.git", ref: "HEAD" },
    ]);
  });

  it("a failing worktreeClean moves the node to blocked with workspace-unreadable and resolves", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, EXPIRED);
    const mock = gitMock({ worktreeError: new GitError("unknown", "m") });
    const result = await runRecover(fixture, mock);
    assert.equal(result.blocked, 1);
    assert.equal(result.findings.length, 1);
    const finding = result.findings[0] as RecoveryFinding;
    assert.equal(finding.step, "leases");
    assert.equal(finding.code, "workspace-unreadable");
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "blocked",
      block_reason: "dirty-recovery",
    });
    assert.equal(fixture.listEvents()[0]!.type, "recovery.leaseBlocked");
  });

  it("three candidates are processed in subject_id order", async (t) => {
    const fixture = seedBase(t);
    const tasks = [
      {
        id: TASK_A,
        workspace: "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        run: "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        path: "workspaces/task-a",
      },
      {
        id: TASK_B,
        workspace: "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        run: "run_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        path: "workspaces/task-b",
      },
      {
        id: TASK_C,
        workspace: "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAX",
        run: "run_01ARZ3NDEKTSV4RRFFQ69G5FAX",
        path: "workspaces/task-c",
      },
    ];
    for (const task of tasks) {
      insertTask(fixture, task.id, "running");
      insertWorkspace(fixture, task.workspace, task.path, task.id);
      insertRun(fixture, task.run, task.id, task.workspace);
      insertLease(fixture, task.id, EXPIRED);
    }
    const mock = gitMock({ clean: true, head: BASE });
    const result = await runRecover(fixture, mock);
    assert.equal(result.returnedToReady, 3);
    assert.deepEqual(mock.worktreeCalls, [
      "workspaces/task-a",
      "workspaces/task-b",
      "workspaces/task-c",
    ]);
  });

  it("a clean expired lease writes running to ready under recovery-requeued", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, EXPIRED);
    const recording = recordingPlanStore(
      createPlanStore(createReadiness(fixture.events, "daemon_test")),
    );
    const mock = gitMock({ clean: true, head: BASE });
    await runRecover(fixture, mock, recording.plan);

    assert.equal(recording.setNodeStateInputs.length, 1);
    assert.deepEqual(recording.setNodeStateInputs[0], {
      id: TASK_A,
      from: "running",
      to: "ready",
      trigger: "recovery-requeued",
      blockReason: null,
      at: NOW,
      cause: {
        revision: `revision_${TASK_A.slice(TASK_A.indexOf("_") + 1)}`,
        importId: null,
      },
    });
  });

  it("a dirty expired lease writes running to blocked under recovery-blocked", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, EXPIRED);
    const recording = recordingPlanStore(
      createPlanStore(createReadiness(fixture.events, "daemon_test")),
    );
    const mock = gitMock({ clean: false, head: BASE });
    await runRecover(fixture, mock, recording.plan);

    assert.equal(recording.setNodeStateInputs.length, 1);
    assert.deepEqual(recording.setNodeStateInputs[0], {
      id: TASK_A,
      from: "running",
      to: "blocked",
      trigger: "recovery-blocked",
      blockReason: "dirty-recovery",
      at: NOW,
      cause: {
        revision: `revision_${TASK_A.slice(TASK_A.indexOf("_") + 1)}`,
        importId: null,
      },
    });
  });

  it("readiness returns an empty transition list for both recovery writes", async (t) => {
    const cleanFixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      cleanFixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      cleanFixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(cleanFixture, TASK_A, EXPIRED);
    const cleanRecording = recordingPlanStore(
      createPlanStore(createReadiness(cleanFixture.events, "daemon_test")),
    );
    await runRecover(
      cleanFixture,
      gitMock({ clean: true, head: BASE }),
      cleanRecording.plan,
    );

    const dirtyFixture = seedTaskFixture(t, TASK_B);
    insertWorkspace(
      dirtyFixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "workspaces/task-b",
    );
    insertRun(
      dirtyFixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      TASK_B,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    );
    insertLease(dirtyFixture, TASK_B, EXPIRED);
    const dirtyRecording = recordingPlanStore(
      createPlanStore(createReadiness(dirtyFixture.events, "daemon_test")),
    );
    await runRecover(
      dirtyFixture,
      gitMock({ clean: false, head: BASE }),
      dirtyRecording.plan,
    );

    assert.deepEqual(cleanRecording.setNodeStateResults[0], []);
    assert.deepEqual(dirtyRecording.setNodeStateResults[0], []);
  });

  it("recovery appends no node.ready and no node.pending event", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "workspaces/task-a",
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      TASK_A,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    insertLease(fixture, TASK_A, EXPIRED);
    const readinessEvents = (): number =>
      fixture
        .listEvents()
        .filter(
          (event) =>
            event.type === "node.ready" || event.type === "node.pending",
        ).length;
    const before = readinessEvents();
    const recording = recordingPlanStore(
      createPlanStore(createReadiness(fixture.events, "daemon_test")),
    );
    await runRecover(
      fixture,
      gitMock({ clean: true, head: BASE }),
      recording.plan,
    );

    assert.equal(before, 0);
    assert.equal(readinessEvents(), 0);
  });

  it("canTransition pins the guard's premise for both targets", () => {
    assert.equal(canTransition("task", "running", "ready"), true);
    assert.equal(canTransition("task", "running", "blocked"), true);
  });

  it("the external task path returns the task to ready under trigger claim-expired", async (t) => {
    const {
      fixture,
      runId,
      attemptId,
      executionFake,
      leaseFake,
      recording,
      mock,
    } = seedExternalTaskClaim(t, TASK_A);
    const result = await runRecover(
      fixture,
      mock,
      recording.plan,
      executionFake.execution,
      leaseFake,
    );
    assert.equal(result.returnedToReady, 1);
    assert.equal(result.blocked, 0);
    assert.equal(result.objectivesFreed, 0);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "ready",
      block_reason: null,
    });
    assert.equal(recording.setNodeStateInputs.length, 1);
    assert.deepEqual(recording.setNodeStateInputs[0], {
      id: TASK_A,
      from: "running",
      to: "ready",
      trigger: "claim-expired",
      blockReason: null,
      at: NOW,
      cause: {
        revision: `revision_${ulidOf(TASK_A)}`,
        importId: null,
      },
    });
    assert.deepEqual(executionFake.endRunCalls, [
      { runId, outcome: "expired", at: NOW },
    ]);
    assert.deepEqual(executionFake.closeAttemptCalls, [
      { attemptId, outcome: "cancelled", at: NOW },
    ]);
    assert.deepEqual(executionFake.attemptsOfRunCalls, [runId]);
    assert.deepEqual(leaseFake.calls, []);
    assert.deepEqual(readLease(fixture, TASK_A), {
      owner: null,
      expires_at: null,
      renewed_at: null,
      fence: 5,
    });
    parseNode(fixture, TASK_A);
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "recovery.leaseRecovered");
    assert.equal(events[0]!.subjectKind, "node");
    assert.equal(events[0]!.subjectId, TASK_A);
    assert.equal(events[0]!.actorKind, "daemon");
    assert.equal(events[0]!.actorId, ACTOR);
    assert.deepEqual(events[0]!.payload, {
      target: "ready",
      clean: false,
      headOid: null,
      baseOid: null,
      fence: 5,
      driver: "external",
      runId,
    });
    parseEvent(events[0]!);
  });

  it("the external task path calls no method of the Git fake", async (t) => {
    const { fixture, executionFake, leaseFake, recording, mock } =
      seedExternalTaskClaim(t, TASK_A);
    await runRecover(
      fixture,
      mock,
      recording.plan,
      executionFake.execution,
      leaseFake,
    );
    assert.deepEqual(mock.worktreeCalls, []);
    assert.deepEqual(mock.headCalls, []);
  });

  it("the external task path never writes dirty-recovery", async (t) => {
    const { fixture, executionFake, leaseFake, recording, mock } =
      seedExternalTaskClaim(t, TASK_A);
    await runRecover(
      fixture,
      mock,
      recording.plan,
      executionFake.execution,
      leaseFake,
    );
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "ready",
      block_reason: null,
    });
    assert.equal(
      fixture
        .listEvents()
        .filter((event) => event.type === "recovery.leaseBlocked").length,
      0,
    );
    assert.equal(recording.setNodeStateInputs[0]!.trigger, "claim-expired");
  });

  it("the external objective path ends the objective run and moves no node state", async (t) => {
    const { fixture, objectiveId, runId, leaseFake, recording, mock } =
      seedExternalObjectiveClaim(t, TASK_A);
    const backed = createBackedExecutionFake({
      ids: createMockIdGenerator({ ulids: [] }),
    });
    const result = await runRecover(
      fixture,
      mock,
      recording.plan,
      backed.execution,
      leaseFake,
    );
    assert.equal(result.objectivesFreed, 1);
    assert.equal(result.returnedToReady, 0);
    assert.equal(result.blocked, 0);
    assert.deepEqual(backed.endRunCalls, [
      { runId, outcome: "expired", at: NOW },
    ]);
    assert.deepEqual(backed.closeAttemptCalls, []);
    assert.equal(recording.setNodeStateInputs.length, 0);
    const node = fixture.storage.transact((transaction) =>
      transaction.get("SELECT state FROM node WHERE id = ?", [objectiveId]),
    ) as { state: string };
    assert.equal(node.state, "running");
    assert.deepEqual(readLease(fixture, objectiveId), {
      owner: null,
      expires_at: null,
      renewed_at: null,
      fence: 3,
    });
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.subjectId, objectiveId);
    assert.deepEqual(events[0]!.payload, {
      target: "running",
      clean: false,
      headOid: null,
      baseOid: null,
      fence: 3,
      driver: "external",
      runId,
    });
  });

  it("the external objective path emits no lease-expired-on-non-task finding", async (t) => {
    const { fixture, leaseFake, recording, mock } = seedExternalObjectiveClaim(
      t,
      TASK_A,
    );
    const backed = createBackedExecutionFake({
      ids: createMockIdGenerator({ ulids: [] }),
    });
    const result = await runRecover(
      fixture,
      mock,
      recording.plan,
      backed.execution,
      leaseFake,
    );
    assert.equal(result.findings.length, 0);
    assert.ok(
      !result.findings.some(
        (finding) => finding.code === "lease-expired-on-non-task",
      ),
    );
  });

  it("the driver branch precedes the missing-workspace check", async (t) => {
    const { fixture, executionFake, leaseFake, recording, mock } =
      seedExternalTaskClaim(t, TASK_A);
    const result = await runRecover(
      fixture,
      mock,
      recording.plan,
      executionFake.execution,
      leaseFake,
    );
    assert.equal(result.blocked, 0);
    assert.equal(result.returnedToReady, 1);
    assert.ok(
      !result.findings.some(
        (finding) => finding.code === "recovery-inputs-missing",
      ),
    );
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "ready",
      block_reason: null,
    });
  });

  it("the lease clear keeps the fence on both paths", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertExternalRun(fixture, {
      id: runIdFor("objective", `objective_${ulidOf(TASK_A)}`),
      kind: "objective",
      nodeId: `objective_${ulidOf(TASK_A)}`,
      parentRunId: null,
      fence: 5,
    });
    insertExternalRun(fixture, {
      id: runIdFor("task", TASK_A),
      kind: "task",
      nodeId: TASK_A,
      parentRunId: runIdFor("objective", `objective_${ulidOf(TASK_A)}`),
      fence: 5,
    });
    insertHeldLease(fixture, {
      subjectId: TASK_A,
      owner: "actor_harness",
      fence: 5,
      expiresAt: EXPIRED,
    });
    insertTask(fixture, TASK_B, "running");
    insertWorkspace(
      fixture,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "workspaces/task-b",
      TASK_B,
    );
    insertRun(
      fixture,
      "run_01ARZ3NDEKTSV4RRFFQ69G5FAW",
      TASK_B,
      "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAW",
    );
    insertLease(fixture, TASK_B, EXPIRED);
    const mock = gitMock({ clean: true, head: BASE });
    const result = await runRecover(fixture, mock);
    assert.equal(result.returnedToReady, 2);
    assert.deepEqual(readLease(fixture, TASK_A), {
      owner: null,
      expires_at: null,
      renewed_at: null,
      fence: 5,
    });
    assert.deepEqual(readLease(fixture, TASK_B), {
      owner: null,
      expires_at: null,
      renewed_at: null,
      fence: 1,
    });
  });

  it("a swept row holds a null in every column but the fence", async (t) => {
    const { fixture, executionFake, leaseFake, recording, mock } =
      seedExternalTaskClaim(t, TASK_A);
    await runRecover(
      fixture,
      mock,
      recording.plan,
      executionFake.execution,
      leaseFake,
    );
    assert.deepEqual(readLeaseRow(fixture, TASK_A), {
      subject_kind: "node",
      subject_id: TASK_A,
      owner: null,
      owner_kind: null,
      fence: 5,
      acquired_at: null,
      renewed_at: null,
      expires_at: null,
    });
  });

  it("the recovery.leaseRecovered payload carries row.fence", async (t) => {
    const { fixture, executionFake, leaseFake, recording, mock } =
      seedExternalTaskClaim(t, TASK_A);
    await runRecover(
      fixture,
      mock,
      recording.plan,
      executionFake.execution,
      leaseFake,
    );
    const payload = fixture.listEvents()[0]!.payload as Readonly<{
      fence: number;
    }>;
    assert.equal(payload.fence, 5);
    assert.notEqual(payload.fence, 6);
  });

  it("sweepExpiredExternalLeases runs inside a supplied transaction", async (t) => {
    const { fixture, runId, attemptId, executionFake, leaseFake, recording } =
      seedExternalTaskClaim(t, TASK_A);
    let swept = false;
    assert.throws(() => {
      fixture.storage.transact((transaction) => {
        const result = sweepExpiredExternalLeases(
          {
            plan: recording.plan,
            lease: leaseFake.lease,
            execution: executionFake.execution,
            events: fixture.events,
          },
          transaction,
          { actor: ACTOR, now: NOW },
        );
        swept = true;
        assert.equal(result.returnedToReady, 1);
        throw new Error("rollback probe");
      });
    }, /rollback probe/);
    assert.equal(swept, true);
    assert.equal(executionFake.endRunCalls.length, 1);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "running",
      block_reason: null,
    });
    const run = fixture.storage.transact((transaction) =>
      transaction.get("SELECT state, outcome FROM run WHERE id = ?", [runId]),
    ) as { state: string; outcome: string | null };
    assert.equal(run.state, "active");
    assert.equal(run.outcome, null);
    const attempt = fixture.storage.transact((transaction) =>
      transaction.get("SELECT outcome FROM attempt WHERE id = ?", [attemptId]),
    ) as { outcome: string | null };
    assert.equal(attempt.outcome, null);
    const lease = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT owner, fence FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
        [TASK_A],
      ),
    ) as { owner: string | null; fence: number };
    assert.equal(lease.owner, "actor_harness");
    assert.equal(lease.fence, 5);
    assert.equal(fixture.listEvents().length, 0);
  });

  it("the sweep is deterministic in row order", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    insertExternalRun(fixture, {
      id: runIdFor("objective", `objective_${ulidOf(TASK_A)}`),
      kind: "objective",
      nodeId: `objective_${ulidOf(TASK_A)}`,
      parentRunId: null,
      fence: 2,
    });
    insertExternalRun(fixture, {
      id: runIdFor("task", TASK_A),
      kind: "task",
      nodeId: TASK_A,
      parentRunId: runIdFor("objective", `objective_${ulidOf(TASK_A)}`),
      fence: 2,
    });
    insertHeldLease(fixture, {
      subjectId: TASK_A,
      owner: "actor_harness",
      fence: 2,
      expiresAt: EXPIRED,
    });
    insertTask(fixture, TASK_B, "running");
    insertExternalRun(fixture, {
      id: runIdFor("objective", `objective_${ulidOf(TASK_B)}`),
      kind: "objective",
      nodeId: `objective_${ulidOf(TASK_B)}`,
      parentRunId: null,
      fence: 4,
    });
    insertExternalRun(fixture, {
      id: runIdFor("task", TASK_B),
      kind: "task",
      nodeId: TASK_B,
      parentRunId: runIdFor("objective", `objective_${ulidOf(TASK_B)}`),
      fence: 4,
    });
    insertHeldLease(fixture, {
      subjectId: TASK_B,
      owner: "actor_harness",
      fence: 4,
      expiresAt: EXPIRED,
    });
    const result = await runRecover(fixture, gitMock({}));
    assert.equal(result.returnedToReady, 2);
    const events = fixture.listEvents();
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => event.subjectId),
      [TASK_A, TASK_B],
    );
  });

  it("one expired claim yields two swept rows", async (t) => {
    const {
      fixture,
      objectiveId,
      runId,
      executionFake,
      leaseFake,
      recording,
      mock,
    } = seedExternalObjectiveClaim(t, TASK_A);
    const taskRunId = runIdFor("task", TASK_A);
    const attemptId = attemptIdFor(TASK_A);
    insertExternalRun(fixture, {
      id: taskRunId,
      kind: "task",
      nodeId: TASK_A,
      parentRunId: runId,
      fence: 2,
    });
    insertExternalAttempt(fixture, { id: attemptId, runId: taskRunId });
    insertHeldLease(fixture, {
      subjectId: TASK_A,
      owner: "actor_harness",
      fence: 2,
      expiresAt: EXPIRED,
    });
    executionFake.attemptsByRun.set(taskRunId, [
      {
        id: attemptId,
        runId: taskRunId,
        driver: "external",
        attemptNo: 1,
        headOid: null,
        outcome: null,
        endedAt: null,
      },
    ]);
    const result = await runRecover(
      fixture,
      mock,
      recording.plan,
      executionFake.execution,
      leaseFake,
    );
    assert.equal(result.returnedToReady, 1);
    assert.equal(result.objectivesFreed, 1);
    assert.equal(result.blocked, 0);
    const events = fixture.listEvents();
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => event.subjectId),
      [objectiveId, TASK_A],
    );
    for (const event of events) {
      assert.equal(event.type, "recovery.leaseRecovered");
    }
    assert.deepEqual(executionFake.endRunCalls, [
      { runId, outcome: "expired", at: NOW },
      { runId: taskRunId, outcome: "expired", at: NOW },
    ]);
    assert.deepEqual(executionFake.closeAttemptCalls, [
      { attemptId, outcome: "cancelled", at: NOW },
    ]);
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "ready",
      block_reason: null,
    });
    const objective = fixture.storage.transact((transaction) =>
      transaction.get("SELECT state FROM node WHERE id = ?", [objectiveId]),
    ) as { state: string };
    assert.equal(objective.state, "running");
  });

  it("the sweep closes only the open attempt of a run with mixed completed and open history", async (t) => {
    const fixture = seedTaskFixture(t, TASK_A);
    const objectiveId = `objective_${ulidOf(TASK_A)}`;
    const runId = runIdFor("task", TASK_A);
    insertExternalRun(fixture, {
      id: runIdFor("objective", objectiveId),
      kind: "objective",
      nodeId: objectiveId,
      parentRunId: null,
      fence: 5,
    });
    insertExternalRun(fixture, {
      id: runId,
      kind: "task",
      nodeId: TASK_A,
      parentRunId: runIdFor("objective", objectiveId),
      fence: 5,
    });
    const completedAttemptId = "attempt_ext_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    const openAttemptId = attemptIdFor(TASK_A);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, 'external', 1, NULL, NULL, NULL, NULL, NULL, 'rejected', ?)",
        [completedAttemptId, runId, NOW - 1000],
      );
      transaction.run(
        "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, 'external', 2, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
        [openAttemptId, runId],
      );
    });
    insertHeldLease(fixture, {
      subjectId: TASK_A,
      owner: "actor_harness",
      fence: 5,
      expiresAt: EXPIRED,
    });
    const mock = gitMock({});
    const backed = createBackedExecutionFake({
      ids: createMockIdGenerator({ ulids: [] }),
    });
    const result = await recoverExpiredLeases(
      {
        storage: fixture.storage,
        plan: createPlanStore(createReadiness(fixture.events, "daemon_test")),
        git: mock.git,
        lease: createLeaseFake().lease,
        execution: backed.execution,
        events: fixture.events,
        clock: fixture.clock,
      },
      { actor: ACTOR },
    );
    assert.equal(result.returnedToReady, 1);
    assert.equal(result.blocked, 0);
    assert.equal(result.objectivesFreed, 0);
    assert.deepEqual(result.findings, []);
    const attemptRows = fixture.storage.transact((transaction) =>
      transaction.all(
        "SELECT id, attempt_no, outcome, ended_at FROM attempt WHERE run_id = ? ORDER BY attempt_no ASC",
        [runId],
      ),
    ) as readonly Readonly<Record<string, unknown>>[];
    assert.deepEqual(
      attemptRows.map((row) => ({ ...row })),
      [
        {
          id: completedAttemptId,
          attempt_no: 1,
          outcome: "rejected",
          ended_at: NOW - 1000,
        },
        {
          id: openAttemptId,
          attempt_no: 2,
          outcome: "cancelled",
          ended_at: NOW,
        },
      ],
    );
    const run = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT id, state, outcome, ended_at FROM run WHERE id = ?",
        [runId],
      ),
    ) as Readonly<Record<string, unknown>>;
    assert.deepEqual(
      { ...run },
      {
        id: runId,
        state: "ended",
        outcome: "expired",
        ended_at: NOW,
      },
    );
    assert.deepEqual(readNode(fixture, TASK_A), {
      state: "ready",
      block_reason: null,
    });
    assert.deepEqual(readLease(fixture, TASK_A), {
      owner: null,
      expires_at: null,
      renewed_at: null,
      fence: 5,
    });
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "recovery.leaseRecovered");
    assert.equal(events[0]!.subjectId, TASK_A);
    assert.deepEqual(events[0]!.payload, {
      target: "ready",
      clean: false,
      headOid: null,
      baseOid: null,
      fence: 5,
      driver: "external",
      runId,
    });
    assert.deepEqual(backed.closeAttemptCalls, [
      { attemptId: openAttemptId, outcome: "cancelled", at: NOW },
    ]);
  });

  it("the objective path ends a released task's still-active run so no epoch dangles", async (t) => {
    const { fixture, objectiveId, runId } = seedExternalObjectiveClaim(
      t,
      TASK_A,
    );
    const danglingTask = "task_01ARZ3NDEKTSV4RRFFQ69G5FBV";
    const danglingRun = `run_ext_task_${danglingTask.slice("task_".length)}`;
    fixture.storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) SELECT ?, project_id, 'task', ?, 'dangling sibling', instruction_blob, acceptance_blob, worker, repository_id, 'ready', NULL, NULL, revision, updated_at FROM node WHERE id = ?",
        [danglingTask, objectiveId, TASK_A],
      );
    });
    insertExternalRun(fixture, {
      id: danglingRun,
      kind: "task",
      nodeId: danglingTask,
      parentRunId: runId,
      fence: 3,
    });
    const recording = recordingPlanStore(
      createPlanStore(createReadiness(fixture.events, "daemon_test")),
    );
    const swept: SweepExpiredExternalLeasesResult[] = [];
    fixture.storage.transact((transaction) => {
      swept.push(
        sweepExpiredExternalLeases(
          {
            plan: recording.plan,
            lease: createLeaseFake().lease,
            execution: createBackedExecutionFake({
              ids: createMockIdGenerator({ ulids: [] }),
            }).execution,
            events: fixture.events,
          },
          transaction,
          { actor: ACTOR, now: NOW },
        ),
      );
    });
    assert.equal(swept.length, 1);
    assert.equal(swept[0]!.objectivesFreed, 1);
    assert.equal(swept[0]!.returnedToReady, 0);
    const taskRun = fixture.storage.transact((transaction) =>
      transaction.get("SELECT state, outcome FROM run WHERE id = ?", [
        danglingRun,
      ]),
    ) as { state: string; outcome: string | null };
    assert.equal(taskRun.state, "ended");
    assert.equal(taskRun.outcome, "expired");
    const objectiveRun = fixture.storage.transact((transaction) =>
      transaction.get("SELECT state, outcome FROM run WHERE id = ?", [runId]),
    ) as { state: string; outcome: string | null };
    assert.equal(objectiveRun.state, "ended");
    assert.equal(objectiveRun.outcome, "expired");
  });

  it("the task path skips a run another writer already ended and still frees the claim", async (t) => {
    const { fixture, runId } = seedExternalTaskClaim(t, TASK_A);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "UPDATE attempt SET outcome = 'cancelled', ended_at = ? WHERE id = ?",
        [NOW - 1, attemptIdFor(TASK_A)],
      );
      transaction.run(
        "UPDATE run SET state = 'ended', outcome = 'released', ended_at = ? WHERE id = ?",
        [NOW - 1, runId],
      );
    });
    const backed = createBackedExecutionFake({
      ids: createMockIdGenerator({ ulids: [] }),
    });
    const recording = recordingPlanStore(
      createPlanStore(createReadiness(fixture.events, "daemon_test")),
    );
    const swept: SweepExpiredExternalLeasesResult[] = [];
    fixture.storage.transact((transaction) => {
      swept.push(
        sweepExpiredExternalLeases(
          {
            plan: recording.plan,
            lease: createLeaseFake().lease,
            execution: backed.execution,
            events: fixture.events,
          },
          transaction,
          { actor: ACTOR, now: NOW },
        ),
      );
    });
    assert.equal(swept.length, 1);
    assert.equal(swept[0]!.returnedToReady, 1);
    assert.deepEqual(backed.endRunCalls, []);
    assert.deepEqual(backed.closeAttemptCalls, []);
    assert.equal(readNode(fixture, TASK_A).state, "ready");
    const lease = readLeaseRow(fixture, TASK_A);
    assert.equal(lease.owner, null);
    assert.equal(lease.expires_at, null);
    const run = fixture.storage.transact((transaction) =>
      transaction.get("SELECT state, outcome FROM run WHERE id = ?", [runId]),
    ) as { state: string; outcome: string | null };
    assert.equal(run.state, "ended");
    assert.equal(run.outcome, "released");
  });

  it("no raw node write survives in the file", async () => {
    const source = fs.readFileSync(
      new URL("./recover-expired-leases.ts", import.meta.url),
      "utf8",
    );
    const rules = await lintCase({
      filePath: "src/commands/startup/recover-expired-leases.ts",
      code: source,
    });
    assert.ok(
      !rules.includes("no-restricted-syntax"),
      `unexpected no-restricted-syntax`,
    );
  });
});
