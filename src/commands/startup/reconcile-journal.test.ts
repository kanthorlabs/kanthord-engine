import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { eventRow } from "../../domain/event.ts";
import { gitOperationRow } from "../../domain/git-operation.ts";
import { ZERO_OID } from "../../domain/recovery.ts";
import type { RecoveryFinding } from "../../domain/recovery.ts";
import { GitError, type Git } from "../../services/git/index.ts";
import { createRecoveryFixture } from "../../../test/helpers/recovery.ts";
import type { RecoveryFixture } from "../../../test/helpers/recovery.ts";
import {
  reconcileJournal,
  type ReconcileJournalResult,
} from "./reconcile-journal.ts";

const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPOSITORY_B = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const ACTOR = "daemon-startup";
const BASE = "a".repeat(40);
const HEAD_OID = "b".repeat(40);
const OTHER = "c".repeat(40);
const NOW = 1700000000000;

type MockConfig = Readonly<{
  observed?: string | null;
  resolveRefError?: unknown;
  onResolveRef?: (input: Readonly<{ gitDir: string; ref: string }>) => void;
  onRemove?: (pidFile: string) => void;
}>;

type Mock = Readonly<{
  git: Git;
  resolveCalls: readonly { gitDir: string; ref: string }[];
  removeCalls: readonly string[];
}>;

function gitMock(config: MockConfig): Mock {
  const resolveCalls: { gitDir: string; ref: string }[] = [];
  const removeCalls: string[] = [];
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
      resolveCalls.push(input);
      config.onResolveRef?.(input);
      if (config.resolveRefError !== undefined) {
        throw config.resolveRefError;
      }
      return config.observed ?? null;
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
    async removePidFile(input: Readonly<{ pidFile: string }>): Promise<void> {
      removeCalls.push(input.pidFile);
      config.onRemove?.(input.pidFile);
    },
    sweepHome(): Promise<never> {
      throw new Error("unexpected sweepHome call");
    },
    worktreeClean(): Promise<never> {
      throw new Error("unexpected worktreeClean call");
    },
  };
  return { git, resolveCalls, removeCalls };
}

function openRow(
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id,
    repository_id: REPOSITORY_ID,
    intent: "merge",
    node_id: null,
    run_id: null,
    candidate_id: null,
    lease_fence: 0,
    ref: "refs/heads/main",
    base_oid: BASE,
    proposed_head_oid: HEAD_OID,
    expected_remote_oid: null,
    child_token: null,
    state: "open",
    result_head_oid: null,
    outcome: null,
    detail_blob: null,
    completed_at: null,
    ...overrides,
  };
}

async function runReconcile(
  fixture: RecoveryFixture,
  mock: Mock,
): Promise<ReconcileJournalResult> {
  return reconcileJournal(
    {
      storage: fixture.storage,
      journal: fixture.journal,
      git: mock.git,
      events: fixture.events,
      clock: fixture.clock,
    },
    { actor: ACTOR },
  );
}

function parseEvent(
  event: Readonly<{
    id: string;
    subjectKind: string;
    subjectId: string;
    type: string;
    actorKind: "human" | "daemon";
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

function parseRow(row: Readonly<Record<string, unknown>>): void {
  assert.doesNotThrow(() =>
    gitOperationRow.parse({
      id: row.id,
      repositoryId: row.repository_id,
      intent: row.intent,
      nodeId: row.node_id,
      runId: row.run_id,
      candidateId: row.candidate_id,
      leaseFence: row.lease_fence,
      ref: row.ref,
      baseOid: row.base_oid,
      proposedHeadOid: row.proposed_head_oid,
      resultHeadOid: row.result_head_oid,
      expectedRemoteOid: row.expected_remote_oid,
      state: row.state,
      outcome: row.outcome,
      detailBlob: row.detail_blob,
      childToken: row.child_token,
      completedAt: row.completed_at,
    }),
  );
}

describe("src/commands/startup/reconcile-journal.test", () => {
  it("a merge row whose ref reads the proposed head is completed with one event", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = "/run/kanthord/run/gitop-row.pid";
    fixture.seedGitOperation(openRow(rowId, { child_token: token }));
    const mock = gitMock({
      observed: HEAD_OID,
      onRemove: () => {
        assert.equal(fixture.readGitOperation(rowId).state, "complete");
      },
    });
    const result = await runReconcile(fixture, mock);
    assert.equal(result.completed, 1);
    assert.equal(result.discarded, 0);
    assert.equal(result.leftOpen, 0);
    assert.deepEqual(result.refusesNewWork, []);
    assert.deepEqual(result.findings, []);
    const row = fixture.readGitOperation(rowId);
    assert.equal(row.state, "complete");
    assert.equal(row.result_head_oid, HEAD_OID);
    assert.equal(row.outcome, "recovered-complete");
    assert.equal(row.child_token, null);
    assert.equal(row.completed_at, NOW);
    parseRow(row);
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "recovery.journalReconciled");
    assert.equal(events[0]!.subjectKind, "repository");
    assert.equal(events[0]!.subjectId, REPOSITORY_ID);
    assert.equal(events[0]!.actorKind, "daemon");
    assert.equal(events[0]!.actorId, ACTOR);
    assert.deepEqual(events[0]!.payload, {
      gitOperationId: rowId,
      intent: "merge",
      ref: "refs/heads/main",
      observed: HEAD_OID,
      verdict: "complete",
    });
    parseEvent(events[0]!);
    assert.deepEqual(mock.resolveCalls, [
      { gitDir: "/run/kanthord/repos/fixture.git", ref: "refs/heads/main" },
    ]);
    assert.deepEqual(mock.removeCalls, [token]);
  });

  it("a sync row whose ref reads the base is discarded", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    fixture.seedGitOperation(
      openRow(rowId, { intent: "sync", ref: "refs/heads/sync" }),
    );
    const mock = gitMock({ observed: BASE });
    const result = await runReconcile(fixture, mock);
    assert.equal(result.discarded, 1);
    assert.equal(result.completed, 0);
    const row = fixture.readGitOperation(rowId);
    assert.equal(row.state, "discarded");
    assert.equal(row.result_head_oid, null);
    assert.equal(row.outcome, "recovered-discarded");
    assert.equal(row.completed_at, NOW);
    parseRow(row);
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, {
      gitOperationId: rowId,
      intent: "sync",
      ref: "refs/heads/sync",
      observed: BASE,
      verdict: "discarded",
    });
  });

  it("a revert row shares the matrix and resolves exactly like a merge", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    fixture.seedGitOperation(
      openRow(rowId, { intent: "revert", ref: "refs/heads/revert" }),
    );
    const mock = gitMock({ observed: HEAD_OID });
    const result = await runReconcile(fixture, mock);
    assert.equal(result.completed, 1);
    const row = fixture.readGitOperation(rowId);
    assert.equal(row.state, "complete");
    assert.equal(row.result_head_oid, HEAD_OID);
    assert.equal(row.outcome, "recovered-complete");
    assert.deepEqual(fixture.listEvents()[0]!.payload, {
      gitOperationId: rowId,
      intent: "revert",
      ref: "refs/heads/revert",
      observed: HEAD_OID,
      verdict: "complete",
    });
  });

  it("a missing ref with a recorded base discards and reports ref-absent-with-base", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    fixture.seedGitOperation(openRow(rowId));
    const mock = gitMock({ observed: null });
    const result = await runReconcile(fixture, mock);
    assert.equal(result.discarded, 1);
    const row = fixture.readGitOperation(rowId);
    assert.equal(row.state, "discarded");
    assert.equal(row.outcome, "recovered-absent");
    assert.equal(result.findings.length, 1);
    const finding = result.findings[0] as RecoveryFinding;
    assert.equal(finding.step, "reconcile");
    assert.equal(finding.code, "ref-absent-with-base");
    assert.equal(finding.repositoryId, REPOSITORY_ID);
    assert.deepEqual(fixture.listEvents()[0]!.payload, {
      gitOperationId: rowId,
      intent: "merge",
      ref: "refs/heads/main",
      observed: null,
      verdict: "absent",
    });
  });

  it("a missing ref with no recorded base discards without a finding", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    fixture.seedGitOperation(openRow(rowId, { base_oid: ZERO_OID }));
    const mock = gitMock({ observed: null });
    const result = await runReconcile(fixture, mock);
    assert.equal(result.discarded, 1);
    assert.deepEqual(result.findings, []);
    assert.equal(fixture.readGitOperation(rowId).state, "discarded");
  });

  it("a ref matching neither base nor proposed head leaves the row open, reports and does not retry", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = "/run/kanthord/run/gitop-row.pid";
    fixture.seedGitOperation(openRow(rowId, { child_token: token }));
    const mock = gitMock({ observed: OTHER });
    const result = await runReconcile(fixture, mock);
    assert.equal(result.leftOpen, 1);
    assert.deepEqual(result.refusesNewWork, [REPOSITORY_ID]);
    assert.equal(result.findings.length, 1);
    const finding = result.findings[0] as RecoveryFinding;
    assert.equal(finding.step, "reconcile");
    assert.equal(finding.code, "ref-unexpected");
    assert.equal(finding.repositoryId, REPOSITORY_ID);
    const row = fixture.readGitOperation(rowId);
    assert.equal(row.state, "open");
    assert.equal(row.outcome, null);
    assert.equal(row.child_token, null);
    assert.equal(row.completed_at, null);
    parseRow(row);
    assert.equal(mock.resolveCalls.length, 1);
    assert.deepEqual(fixture.listEvents()[0]!.payload, {
      gitOperationId: rowId,
      intent: "merge",
      ref: "refs/heads/main",
      observed: OTHER,
      verdict: "unexpected",
    });
    assert.deepEqual(mock.removeCalls, [token]);
  });

  it("an unreadable ref refuses startup with ref-unreadable and changes nothing", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = "/run/kanthord/run/gitop-row.pid";
    fixture.seedGitOperation(openRow(rowId, { child_token: token }));
    const mock = gitMock({ resolveRefError: new GitError("lock-held", "m") });
    await assert.rejects(
      () => runReconcile(fixture, mock),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "RecoveryError" &&
        (error as { code?: unknown }).code === "ref-unreadable" &&
        error.message.includes("refs/heads/main") &&
        error.message.includes(REPOSITORY_ID),
    );
    const row = fixture.readGitOperation(rowId);
    assert.equal(row.state, "open");
    assert.equal(row.child_token, token);
    assert.equal(fixture.listEvents().length, 0);
    assert.deepEqual(mock.removeCalls, []);
  });

  it("a publish row is marked pending, refuses new work and never reads the ref", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = "/run/kanthord/run/gitop-row.pid";
    fixture.seedGitOperation(
      openRow(rowId, {
        intent: "publish",
        ref: "refs/heads/kanthord/publish",
        child_token: token,
      }),
    );
    const mock = gitMock({});
    const result = await runReconcile(fixture, mock);
    assert.equal(result.leftOpen, 1);
    assert.equal(result.completed, 0);
    assert.deepEqual(result.refusesNewWork, [REPOSITORY_ID]);
    assert.deepEqual(result.findings, []);
    const row = fixture.readGitOperation(rowId);
    assert.equal(row.state, "open");
    assert.equal(row.outcome, "awaiting-remote-reconcile");
    assert.equal(row.child_token, null);
    assert.equal(row.completed_at, null);
    parseRow(row);
    assert.deepEqual(mock.resolveCalls, []);
    assert.deepEqual(mock.removeCalls, [token]);
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "recovery.publishReconcilePending");
    assert.equal(events[0]!.subjectKind, "repository");
    assert.equal(events[0]!.subjectId, REPOSITORY_ID);
    assert.deepEqual(events[0]!.payload, {
      gitOperationId: rowId,
      ref: "refs/heads/kanthord/publish",
      proposedHeadOid: HEAD_OID,
    });
    parseEvent(events[0]!);
  });

  it("refusesNewWork lists two open publish repositories bytewise sorted", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture-a",
      homePath: "/run/kanthord/repos/fixture-a.git",
    });
    fixture.seedRepository({
      id: REPOSITORY_B,
      name: "fixture-b",
      homePath: "/run/kanthord/repos/fixture-b.git",
    });
    fixture.seedGitOperation(
      openRow("gitop_01J0AAAAAAAAAAAAAAAAAAAAAA", {
        repository_id: REPOSITORY_B,
        intent: "publish",
        ref: "refs/heads/kanthord/publish",
      }),
    );
    fixture.seedGitOperation(
      openRow("gitop_01J0BBBBBBBBBBBBBBBBBBBBBB", {
        intent: "publish",
        ref: "refs/heads/kanthord/publish",
      }),
    );
    const result = await runReconcile(fixture, gitMock({}));
    assert.deepEqual(result.refusesNewWork, [REPOSITORY_ID, REPOSITORY_B]);
  });

  it("a repository holding two open publish rows appears once in refusesNewWork", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    fixture.seedGitOperation(
      openRow("gitop_01J0AAAAAAAAAAAAAAAAAAAAAA", {
        intent: "publish",
        ref: "refs/heads/kanthord/publish",
      }),
    );
    fixture.seedGitOperation(
      openRow("gitop_01J0BBBBBBBBBBBBBBBBBBBBBB", {
        intent: "publish",
        ref: "refs/heads/kanthord/publish",
      }),
    );
    const result = await runReconcile(fixture, gitMock({}));
    assert.equal(result.refusesNewWork.length, 1);
    assert.deepEqual(result.refusesNewWork, [REPOSITORY_ID]);
    assert.equal(result.leftOpen, 2);
  });

  it("rows are reconciled in id order, one resolveRef per row", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    const rowC = "gitop_01J0CCCCCCCCCCCCCCCCCCCCCC";
    const rowA = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const rowB = "gitop_01J0BBBBBBBBBBBBBBBBBBBBBB";
    fixture.seedGitOperation(openRow(rowC, { ref: "refs/heads/c" }));
    fixture.seedGitOperation(openRow(rowA, { ref: "refs/heads/a" }));
    fixture.seedGitOperation(openRow(rowB, { ref: "refs/heads/b" }));
    const mock = gitMock({ observed: HEAD_OID });
    const result = await runReconcile(fixture, mock);
    assert.equal(result.completed, 3);
    assert.deepEqual(
      mock.resolveCalls.map((call) => call.ref),
      ["refs/heads/a", "refs/heads/b", "refs/heads/c"],
    );
  });
});
