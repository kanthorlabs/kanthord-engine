import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { eventRow } from "../../domain/event.ts";
import { RecoveryError } from "../../domain/recovery.ts";
import type { ReapReport } from "../../domain/recovery.ts";
import type {
  ChildInspection,
  Git,
  StopChildInput,
} from "../../services/git/index.ts";
import { createRecoveryFixture } from "../../../test/helpers/recovery.ts";
import type { RecoveryFixture } from "../../../test/helpers/recovery.ts";
import { reapOrphans } from "./reap-orphans.ts";

const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ACTOR = "daemon-startup";
const GRACE_MS = 500;

type MockConfig = Readonly<{
  listPidFiles?: readonly string[];
  inspections?: Readonly<Record<string, ChildInspection>>;
  stopResult?: boolean;
  onStop?: (input: StopChildInput) => void;
  onRemove?: (pidFile: string) => void;
}>;

type Mock = Readonly<{
  git: Git;
  inspectCalls: readonly { pidFile: string }[];
  stopCalls: readonly StopChildInput[];
  removeCalls: readonly string[];
}>;

function gitMock(config: MockConfig): Mock {
  const inspectCalls: { pidFile: string }[] = [];
  const stopCalls: StopChildInput[] = [];
  const removeCalls: string[] = [];
  const git: Git = {
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
    resolveRef(): Promise<never> {
      throw new Error("unexpected resolveRef call");
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
    async inspectChild(
      input: Readonly<{ pidFile: string }>,
    ): Promise<ChildInspection> {
      inspectCalls.push(input);
      const inspection = config.inspections?.[input.pidFile];
      if (inspection === undefined) {
        throw new Error(`no inspection configured for ${input.pidFile}`);
      }
      return inspection;
    },
    async stopChild(input: StopChildInput): Promise<boolean> {
      stopCalls.push(input);
      config.onStop?.(input);
      return config.stopResult ?? true;
    },
    async listPidFiles(): Promise<readonly string[]> {
      return config.listPidFiles ?? [];
    },
    async removePidFile(input: Readonly<{ pidFile: string }>): Promise<void> {
      removeCalls.push(input.pidFile);
      config.onRemove?.(input.pidFile);
    },
    async sweepHome(): Promise<never> {
      throw new Error("unexpected sweepHome call");
    },
    async worktreeClean(): Promise<never> {
      throw new Error("unexpected worktreeClean call");
    },
  };
  return { git, inspectCalls, stopCalls, removeCalls };
}

function openRow(
  id: string,
  childToken: string | null,
  repositoryId: string = REPOSITORY_ID,
): Readonly<Record<string, unknown>> {
  return {
    id,
    repository_id: repositoryId,
    intent: "merge",
    node_id: null,
    run_id: null,
    candidate_id: null,
    lease_fence: 0,
    ref: "refs/heads/main",
    base_oid: "a".repeat(40),
    proposed_head_oid: "b".repeat(40),
    expected_remote_oid: null,
    child_token: childToken,
    state: "open",
    result_head_oid: null,
    outcome: null,
    detail_blob: null,
    completed_at: null,
  };
}

async function runReap(
  fixture: RecoveryFixture,
  mock: Mock,
  runDirectory: string,
): Promise<ReapReport> {
  return reapOrphans(
    {
      storage: fixture.storage,
      journal: fixture.journal,
      git: mock.git,
      events: fixture.events,
      clock: fixture.clock,
      runDirectory,
      graceMs: GRACE_MS,
    },
    { actor: ACTOR },
  );
}

function inFlightIds(fixture: RecoveryFixture): readonly string[] {
  return fixture.storage.transact((transaction) =>
    fixture.journal.listInFlight(transaction).map((row) => row.id),
  );
}

function tempRunDirectory(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-reap-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("src/commands/startup/reap-orphans.test", () => {
  it("two in-flight rows and one unreferenced pid file are inspected in that order", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: join(runDirectory, "home.git"),
    });
    const rowA = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const rowB = "gitop_01J0BBBBBBBBBBBBBBBBBBBBBB";
    const tokenA = join(runDirectory, "gitop-rowA.pid");
    const tokenB = join(runDirectory, "gitop-rowB.pid");
    const unreferenced = join(runDirectory, "git-deadbeef.pid");
    fixture.seedGitOperation(openRow(rowA, tokenA));
    fixture.seedGitOperation(openRow(rowB, tokenB));
    const mock = gitMock({
      listPidFiles: [unreferenced],
      inspections: {
        [tokenA]: { finding: "process-absent", pid: 1001 },
        [tokenB]: { finding: "process-absent", pid: 1002 },
        [unreferenced]: { finding: "process-absent", pid: 1003 },
      },
    });
    const report = await runReap(fixture, mock, runDirectory);
    assert.deepEqual(mock.inspectCalls, [
      { pidFile: tokenA },
      { pidFile: tokenB },
      { pidFile: unreferenced },
    ]);
    assert.deepEqual(report.children, [
      {
        pidFile: tokenA,
        gitOperationId: rowA,
        repositoryId: REPOSITORY_ID,
        finding: "process-absent",
      },
      {
        pidFile: tokenB,
        gitOperationId: rowB,
        repositoryId: REPOSITORY_ID,
        finding: "process-absent",
      },
      {
        pidFile: unreferenced,
        gitOperationId: null,
        repositoryId: null,
        finding: "process-absent",
      },
    ]);
    assert.deepEqual(mock.removeCalls, [tokenA, tokenB, unreferenced]);
  });

  it("two unreferenced pid files are inspected in bytewise path order", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    const a = join(runDirectory, "a.pid");
    const b = join(runDirectory, "b.pid");
    const mock = gitMock({
      listPidFiles: [a, b],
      inspections: {
        [a]: { finding: "process-absent", pid: 2001 },
        [b]: { finding: "process-absent", pid: 2002 },
      },
    });
    await runReap(fixture, mock, runDirectory);
    assert.deepEqual(mock.inspectCalls, [{ pidFile: a }, { pidFile: b }]);
  });

  it("an alive child that stops clears the token, appends one event and removes the file once", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: join(runDirectory, "home.git"),
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = join(runDirectory, "gitop-row.pid");
    fixture.seedGitOperation(openRow(rowId, token));
    const mock = gitMock({
      inspections: {
        [token]: { finding: "alive", pid: 4242, pidFile: token },
      },
      stopResult: true,
    });
    const report = await runReap(fixture, mock, runDirectory);
    assert.deepEqual(report.children, [
      {
        pidFile: token,
        gitOperationId: rowId,
        repositoryId: REPOSITORY_ID,
        finding: "stopped",
      },
    ]);
    assert.equal(fixture.readGitOperation(rowId).child_token, null);
    assert.deepEqual(mock.stopCalls, [{ pid: 4242, graceMs: GRACE_MS }]);
    assert.deepEqual(mock.removeCalls, [token]);
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.type, "recovery.childReaped");
    assert.equal(event.subjectKind, "repository");
    assert.equal(event.subjectId, REPOSITORY_ID);
    assert.equal(event.actorKind, "daemon");
    assert.equal(event.actorId, ACTOR);
    assert.deepEqual(event.payload, {
      gitOperationId: rowId,
      pidFile: token,
      finding: "stopped",
    });
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
  });

  it("the lock file still exists while the child lives and after the reap returns", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const dir = mkdtempSync(join(tmpdir(), "kanthord-reap-lock-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const homePath = join(dir, "home.git");
    const lock = join(homePath, "refs", "heads", "main.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");
    fixture.seedRepository({ id: REPOSITORY_ID, name: "fixture", homePath });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = join(dir, "run", "gitop-row.pid");
    fixture.seedGitOperation(openRow(rowId, token));
    const mock = gitMock({
      inspections: {
        [token]: { finding: "alive", pid: 4242, pidFile: token },
      },
      onStop: () => {
        assert.equal(existsSync(lock), true);
      },
    });
    await runReap(fixture, mock, dir);
    assert.equal(existsSync(lock), true);
  });

  it("a child that will not exit refuses startup with orphan-alive and changes nothing", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: join(runDirectory, "home.git"),
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = join(runDirectory, "gitop-row.pid");
    fixture.seedGitOperation(openRow(rowId, token));
    const mock = gitMock({
      inspections: {
        [token]: { finding: "alive", pid: 4242, pidFile: token },
      },
      stopResult: false,
    });
    await assert.rejects(
      () => runReap(fixture, mock, runDirectory),
      (error: unknown) =>
        error instanceof RecoveryError &&
        error.code === "orphan-alive" &&
        error.name === "RecoveryError" &&
        error.message.includes(String(4242)) &&
        error.message.includes(REPOSITORY_ID) &&
        error.message.includes(token),
    );
    assert.equal(fixture.readGitOperation(rowId).child_token, token);
    assert.equal(fixture.listEvents().length, 0);
    assert.deepEqual(mock.removeCalls, []);
  });

  it("a reused pid is left alone, its token is cleared and the report carries pid-reused", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: join(runDirectory, "home.git"),
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = join(runDirectory, "gitop-row.pid");
    fixture.seedGitOperation(openRow(rowId, token));
    const mock = gitMock({
      inspections: {
        [token]: {
          finding: "started-later",
          pid: 4242,
          startedAt: 1700000001,
          recordedAt: 1700000000,
        },
      },
    });
    const report = await runReap(fixture, mock, runDirectory);
    assert.deepEqual(mock.stopCalls, []);
    assert.equal(fixture.readGitOperation(rowId).child_token, null);
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, {
      gitOperationId: rowId,
      pidFile: token,
      finding: "started-later",
    });
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]!.step, "reap");
    assert.equal(report.findings[0]!.code, "pid-reused");
    assert.equal(report.findings[0]!.repositoryId, REPOSITORY_ID);
  });

  it("a missing pid file clears the token and carries no finding", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: join(runDirectory, "home.git"),
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = join(runDirectory, "gitop-row.pid");
    fixture.seedGitOperation(openRow(rowId, token));
    const mock = gitMock({
      inspections: { [token]: { finding: "no-pid-file" } },
    });
    const report = await runReap(fixture, mock, runDirectory);
    assert.equal(fixture.readGitOperation(rowId).child_token, null);
    assert.deepEqual(report.findings, []);
    assert.equal(fixture.listEvents().length, 1);
    assert.deepEqual(fixture.listEvents()[0]!.payload, {
      gitOperationId: rowId,
      pidFile: token,
      finding: "no-pid-file",
    });
    assert.deepEqual(mock.removeCalls, [token]);
  });

  it("an unreadable pid file clears the token and is reported", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: join(runDirectory, "home.git"),
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = join(runDirectory, "gitop-row.pid");
    fixture.seedGitOperation(openRow(rowId, token));
    const mock = gitMock({
      inspections: {
        [token]: {
          finding: "pid-file-unreadable",
          detail: "not a regular file",
        },
      },
    });
    const report = await runReap(fixture, mock, runDirectory);
    assert.equal(fixture.readGitOperation(rowId).child_token, null);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]!.step, "reap");
    assert.equal(report.findings[0]!.code, "pid-file-unreadable");
    assert.equal(report.findings[0]!.repositoryId, REPOSITORY_ID);
  });

  it("liveness-unknown refuses startup and changes nothing", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: join(runDirectory, "home.git"),
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = join(runDirectory, "gitop-row.pid");
    fixture.seedGitOperation(openRow(rowId, token));
    const mock = gitMock({
      inspections: {
        [token]: {
          finding: "liveness-unknown",
          pid: 4242,
          detail: "ps exited non-zero",
        },
      },
    });
    await assert.rejects(
      () => runReap(fixture, mock, runDirectory),
      (error: unknown) =>
        error instanceof RecoveryError &&
        error.code === "liveness-unknown" &&
        error.name === "RecoveryError" &&
        error.message.includes(String(4242)) &&
        error.message.includes("ps exited non-zero"),
    );
    assert.equal(fixture.readGitOperation(rowId).child_token, token);
    assert.equal(fixture.listEvents().length, 0);
    assert.deepEqual(mock.removeCalls, []);
    assert.deepEqual(mock.stopCalls, []);
  });

  it("a seed pid file with no journal row is reaped on its captured repository", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: join(runDirectory, "home.git"),
    });
    const seedFile = join(
      runDirectory,
      "seed-repo_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid",
    );
    const mock = gitMock({
      listPidFiles: [seedFile],
      inspections: {
        [seedFile]: { finding: "alive", pid: 5150, pidFile: seedFile },
      },
    });
    const report = await runReap(fixture, mock, runDirectory);
    assert.deepEqual(mock.removeCalls, [seedFile]);
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.subjectId, REPOSITORY_ID);
    assert.deepEqual(events[0]!.payload, {
      gitOperationId: null,
      pidFile: seedFile,
      finding: "stopped",
    });
    assert.deepEqual(report.children, [
      {
        pidFile: seedFile,
        gitOperationId: null,
        repositoryId: REPOSITORY_ID,
        finding: "stopped",
      },
    ]);
  });

  it("a gitop pid file whose row exists is reaped on that row's repository", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: join(runDirectory, "home.git"),
    });
    const rowId = "gitop_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    fixture.seedGitOperation(openRow(rowId, null));
    const gitopFile = join(
      runDirectory,
      "gitop-gitop_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid",
    );
    const mock = gitMock({
      listPidFiles: [gitopFile],
      inspections: {
        [gitopFile]: { finding: "alive", pid: 6161, pidFile: gitopFile },
      },
    });
    const report = await runReap(fixture, mock, runDirectory);
    assert.equal(fixture.listEvents().length, 1);
    assert.equal(fixture.listEvents()[0]!.subjectId, REPOSITORY_ID);
    assert.deepEqual(fixture.listEvents()[0]!.payload, {
      gitOperationId: rowId,
      pidFile: gitopFile,
      finding: "stopped",
    });
    assert.deepEqual(report.children, [
      {
        pidFile: gitopFile,
        gitOperationId: rowId,
        repositoryId: REPOSITORY_ID,
        finding: "stopped",
      },
    ]);
  });

  it("a gitop pid file whose row does not exist produces no event", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    const gitopFile = join(
      runDirectory,
      "gitop-gitop_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid",
    );
    const mock = gitMock({
      listPidFiles: [gitopFile],
      inspections: {
        [gitopFile]: { finding: "alive", pid: 7171, pidFile: gitopFile },
      },
    });
    const report = await runReap(fixture, mock, runDirectory);
    assert.equal(fixture.listEvents().length, 0);
    assert.deepEqual(report.children, [
      {
        pidFile: gitopFile,
        gitOperationId: "gitop_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        repositoryId: null,
        finding: "stopped",
      },
    ]);
  });

  it("a runner-minted git pid file is inspected, stopped and removed and produces no event", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    const gitFile = join(runDirectory, "git-3f2a.pid");
    const mock = gitMock({
      listPidFiles: [gitFile],
      inspections: {
        [gitFile]: { finding: "alive", pid: 8181, pidFile: gitFile },
      },
    });
    const report = await runReap(fixture, mock, runDirectory);
    assert.equal(fixture.listEvents().length, 0);
    assert.deepEqual(mock.removeCalls, [gitFile]);
    assert.deepEqual(report.children, [
      {
        pidFile: gitFile,
        gitOperationId: null,
        repositoryId: null,
        finding: "stopped",
      },
    ]);
  });

  it("every pid file in the run directory is inspected whatever its name", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    const names = [
      "a.pid",
      "b.pid",
      "git-cafe.pid",
      "probe-1.pid",
      "keyscan-2.pid",
      "seed-repo_01ARZ3NDEKTSV4RRFFQ69G5FAV.pid",
    ];
    const paths = names.map((name) => join(runDirectory, name));
    const inspections: Readonly<Record<string, ChildInspection>> =
      Object.fromEntries(
        paths.map((path, index) => [
          path,
          { finding: "process-absent", pid: 9000 + index },
        ]),
      );
    const mock = gitMock({ listPidFiles: paths, inspections });
    const report = await runReap(fixture, mock, runDirectory);
    assert.deepEqual(
      mock.inspectCalls,
      paths.map((pidFile) => ({ pidFile })),
    );
    assert.equal(report.children.length, 6);
  });

  it("every removal happens after its transaction committed", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: join(runDirectory, "home.git"),
    });
    const rowId = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const token = join(runDirectory, "gitop-row.pid");
    fixture.seedGitOperation(openRow(rowId, token));
    const mock = gitMock({
      inspections: {
        [token]: { finding: "alive", pid: 4242, pidFile: token },
      },
      onRemove: () => {
        assert.equal(fixture.readGitOperation(rowId).child_token, null);
      },
    });
    await runReap(fixture, mock, runDirectory);
  });

  it("a second reap on the same storage inspects only the source-2 files", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const runDirectory = tempRunDirectory(t);
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: join(runDirectory, "home.git"),
    });
    const rowA = "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA";
    const rowB = "gitop_01J0BBBBBBBBBBBBBBBBBBBBBB";
    const tokenA = join(runDirectory, "gitop-rowA.pid");
    const tokenB = join(runDirectory, "gitop-rowB.pid");
    fixture.seedGitOperation(openRow(rowA, tokenA));
    fixture.seedGitOperation(openRow(rowB, tokenB));
    const mock = gitMock({
      inspections: {
        [tokenA]: { finding: "alive", pid: 4242, pidFile: tokenA },
        [tokenB]: { finding: "alive", pid: 4243, pidFile: tokenB },
      },
    });
    await runReap(fixture, mock, runDirectory);
    assert.deepEqual(inFlightIds(fixture), []);
    await runReap(fixture, mock, runDirectory);
    assert.deepEqual(mock.inspectCalls, [
      { pidFile: tokenA },
      { pidFile: tokenB },
    ]);
  });
});
