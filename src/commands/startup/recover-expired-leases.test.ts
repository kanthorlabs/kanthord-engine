import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { eventRow } from "../../domain/event.ts";
import { nodeRow } from "../../domain/node.ts";
import { canTransition } from "../../domain/transition.ts";
import type { RecoveryFinding } from "../../domain/recovery.ts";
import { GitError, type Git } from "../../services/git/index.ts";
import { createRecoveryFixture } from "../../../test/helpers/recovery.ts";
import type { RecoveryFixture } from "../../../test/helpers/recovery.ts";
import {
  seedExecution,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import {
  recoverExpiredLeases,
  type RecoverExpiredLeasesResult,
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
      "INSERT INTO plan_revision (id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
      "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        repositoryId,
        `repo-${ulid}`,
        "https://example.invalid/fixture.git",
        "provider_a",
        "repos/fixture.git",
        "main",
        "kanthord/landing",
        "refs/heads/kanthord/publish",
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
        "INSERT INTO run (id, kind, node_id, parent_run_id, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      "INSERT INTO run (id, kind, node_id, parent_run_id, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
): Promise<RecoverExpiredLeasesResult> {
  return recoverExpiredLeases(
    {
      storage: fixture.storage,
      git: mock.git,
      events: fixture.events,
      clock: fixture.clock,
    },
    { actor: ACTOR },
  );
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
      fence: 2,
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
      fence: 2,
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
      fence: 2,
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
      fence: 2,
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
      fence: 2,
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

  it("an expired lease on an objective node is reported and changes nothing", async (t) => {
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

  it("canTransition pins the guard's premise for both targets", () => {
    assert.equal(canTransition("task", "running", "ready"), true);
    assert.equal(canTransition("task", "running", "blocked"), true);
  });
});
