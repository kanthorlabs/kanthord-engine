import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import {
  fixtureObjectIds,
  seedRepositories,
} from "../../../test/helpers/remote/seed.ts";
import type { SeedRoot } from "../../../test/helpers/remote/seed.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import type { TemporaryStorage } from "../../../test/helpers/database.ts";
import { fixtureIds, seedRegistry } from "../../../test/helpers/rows.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import type { Transaction } from "../storage/index.ts";

import type { GitPaths, OutsideWriterVerdict } from "./index.ts";
import { createGitRunner } from "./run.ts";
import type { GitRunner, GitRunResult } from "./run.ts";
import {
  LAST_COMPLETED_SQL,
  checkOutsideWriter,
  lastCompletedOid,
} from "./outside-writer.ts";

const tools: Tools = resolveTools();
const c1 = "7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca";
const c2 = "251c92d5a215053aea80432f179653f99072835d";
const c9 = "9".repeat(40);

const ulidA = "01J7Z8X9Y0ABCDEFGHJKMNPQRA";
const ulidB = "01J7Z8X9Y0ABCDEFGHJKMNPQRB";

const directories: string[] = [];
const disposers: Array<() => void> = [];

let seeded: SeedRoot;

before(() => {
  seeded = seedRepositories(tools);
});

after(() => {
  for (const dispose of disposers) {
    dispose();
  }
  seeded?.dispose();
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type OperationRow = Readonly<{
  id: string;
  intent: "merge" | "sync" | "publish" | "revert";
  state: "open" | "complete" | "discarded";
  resultHeadOid: string | null;
  outcome?: string | null;
  completedAt: number | null;
  ref?: string;
}>;

function makeStorage(): TemporaryStorage {
  const temporary = createMigratedStorage();
  disposers.push(temporary.dispose);
  temporary.storage.transact((transaction) => seedRegistry(transaction));
  return temporary;
}

function insertOperation(storage: TemporaryStorage, row: OperationRow): void {
  storage.storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO git_operation (id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        row.id,
        fixtureIds.repository,
        row.intent,
        null,
        null,
        null,
        1,
        row.ref ?? "refs/heads/main",
        "a".repeat(40),
        "b".repeat(40),
        row.resultHeadOid,
        null,
        row.state,
        row.outcome ?? null,
        null,
        row.completedAt,
      ],
    );
  });
}

function makePaths(): GitPaths {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-outwriter-"));
  directories.push(dir);
  const home = join(dir, "home");
  const keyDirectory = join(dir, "keys");
  const knownHosts = join(dir, "known_hosts");
  const runDirectory = join(dir, "run");
  for (const sub of [home, keyDirectory, runDirectory]) {
    mkdirSync(sub);
  }
  writeFileSync(knownHosts, "");
  const fixturePath = seeded.repositories["fixture.git"]?.path;
  assert.ok(fixturePath, "fixture.git must be seeded");
  cpSync(fixturePath, home, { recursive: true });
  return {
    git: tools.paths.git,
    ssh: tools.paths.ssh,
    sshKeyscan: tools.paths.sshKeyscan,
    home,
    keyDirectory,
    knownHosts,
    runDirectory,
  };
}

async function runGit(
  runner: GitRunner,
  paths: GitPaths,
  args: readonly string[],
): Promise<GitRunResult> {
  return runner({ args: ["--git-dir=" + paths.home, ...args] });
}

async function rewindTo(
  runner: GitRunner,
  paths: GitPaths,
  oid: string,
): Promise<void> {
  const result = await runGit(runner, paths, [
    "update-ref",
    "refs/heads/main",
    oid,
    c2,
  ]);
  assert.equal(result.code, 0, result.stderr);
}

function runCheck(
  storage: TemporaryStorage,
  runner: GitRunner,
  input: Readonly<{
    gitDir: string;
    repositoryId: string;
    ref: string;
    intent: "merge" | "sync" | "publish" | "revert";
  }>,
): Promise<OutsideWriterVerdict> {
  let verdictPromise: Promise<OutsideWriterVerdict> | undefined;
  storage.storage.transact((transaction) => {
    verdictPromise = checkOutsideWriter(runner, { transaction, ...input });
  });
  return verdictPromise!;
}

describe("src/services/git/outside-writer.test", () => {
  it("the pinned object ids match the fixture", () => {
    assert.equal(fixtureObjectIds.commit1, c1);
    assert.equal(fixtureObjectIds.commit2, c2);
  });

  it("LAST_COMPLETED_SQL is the documented statement", () => {
    assert.ok(LAST_COMPLETED_SQL.includes("intent = ?"), LAST_COMPLETED_SQL);
    assert.ok(
      LAST_COMPLETED_SQL.includes("state = 'complete'"),
      LAST_COMPLETED_SQL,
    );
    assert.ok(
      LAST_COMPLETED_SQL.includes("result_head_oid IS NOT NULL"),
      LAST_COMPLETED_SQL,
    );
    assert.ok(
      LAST_COMPLETED_SQL.includes("ORDER BY completed_at DESC, id DESC"),
      LAST_COMPLETED_SQL,
    );
    assert.ok(!LAST_COMPLETED_SQL.includes("SELECT *"), LAST_COMPLETED_SQL);
  });

  it("a malformed transaction row degrades to null", () => {
    const base = {
      repositoryId: fixtureIds.repository,
      ref: "refs/heads/main",
      intent: "sync" as const,
    };
    const withRow = (value: unknown): Transaction =>
      ({ get: () => value }) as unknown as Transaction;
    const degradesToNull: readonly unknown[] = [
      null,
      undefined,
      42,
      "a string",
      [],
      {},
      { result_head_oid: 42 },
      { result_head_oid: null },
      { result_head_oid: undefined },
      { result_head_oid: {} },
      { other_column: c1 },
    ];
    for (const row of degradesToNull) {
      assert.equal(
        lastCompletedOid({ transaction: withRow(row), ...base }),
        null,
        JSON.stringify(row) ?? String(row),
      );
    }
    assert.equal(
      lastCompletedOid({
        transaction: withRow({ result_head_oid: c1 }),
        ...base,
      }),
      c1,
    );
  });

  it("a match compares against the last completed result oid", async () => {
    const storage = makeStorage();
    const ids = createMockIdGenerator({ ulids: [ulidA] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    insertOperation(storage, {
      id: ids.mint("gitOperation"),
      intent: "sync",
      state: "complete",
      resultHeadOid: c1,
      completedAt: clock.now(),
    });
    const paths = makePaths();
    const runner = createGitRunner(paths);
    await rewindTo(runner, paths, c1);
    const verdict = await runCheck(storage, runner, {
      gitDir: paths.home,
      repositoryId: fixtureIds.repository,
      ref: "refs/heads/main",
      intent: "sync",
    });
    assert.deepEqual(verdict, { expected: true, oid: c1 });
  });

  it("a mismatch reports both object ids", async () => {
    const storage = makeStorage();
    const ids = createMockIdGenerator({ ulids: [ulidA] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    insertOperation(storage, {
      id: ids.mint("gitOperation"),
      intent: "sync",
      state: "complete",
      resultHeadOid: c1,
      completedAt: clock.now(),
    });
    const paths = makePaths();
    const runner = createGitRunner(paths);
    await rewindTo(runner, paths, c1);
    const human = await runGit(runner, paths, [
      "update-ref",
      "refs/heads/main",
      c2,
      c1,
    ]);
    assert.equal(human.code, 0, human.stderr);
    const verdict = await runCheck(storage, runner, {
      gitDir: paths.home,
      repositoryId: fixtureIds.repository,
      ref: "refs/heads/main",
      intent: "sync",
    });
    assert.deepEqual(verdict, {
      expected: false,
      expectedOid: c1,
      observedOid: c2,
    });
  });

  it("no recorded operation and no ref is expected with a null oid", async () => {
    const storage = makeStorage();
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const verdict = await runCheck(storage, runner, {
      gitDir: paths.home,
      repositoryId: fixtureIds.repository,
      ref: "refs/heads/absent",
      intent: "sync",
    });
    assert.deepEqual(verdict, { expected: true, oid: null });
  });

  it("no recorded operation and a live ref mismatch with no expected oid", async () => {
    const storage = makeStorage();
    const paths = makePaths();
    const runner = createGitRunner(paths);
    await rewindTo(runner, paths, c1);
    const verdict = await runCheck(storage, runner, {
      gitDir: paths.home,
      repositoryId: fixtureIds.repository,
      ref: "refs/heads/main",
      intent: "sync",
    });
    assert.deepEqual(verdict, {
      expected: false,
      expectedOid: null,
      observedOid: c1,
    });
  });

  it("the intent filter separates publish from sync", async () => {
    const storage = makeStorage();
    const ids = createMockIdGenerator({ ulids: [ulidA, ulidB] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const publishAt = clock.now();
    const syncAt = clock.now();
    insertOperation(storage, {
      id: ids.mint("gitOperation"),
      intent: "publish",
      state: "complete",
      resultHeadOid: c9,
      completedAt: publishAt,
    });
    insertOperation(storage, {
      id: ids.mint("gitOperation"),
      intent: "sync",
      state: "complete",
      resultHeadOid: c1,
      completedAt: syncAt,
    });
    const paths = makePaths();
    const runner = createGitRunner(paths);
    await rewindTo(runner, paths, c1);
    const syncVerdict = await runCheck(storage, runner, {
      gitDir: paths.home,
      repositoryId: fixtureIds.repository,
      ref: "refs/heads/main",
      intent: "sync",
    });
    assert.deepEqual(syncVerdict, { expected: true, oid: c1 });
    const publishVerdict = await runCheck(storage, runner, {
      gitDir: paths.home,
      repositoryId: fixtureIds.repository,
      ref: "refs/heads/main",
      intent: "publish",
    });
    assert.deepEqual(publishVerdict, {
      expected: false,
      expectedOid: c9,
      observedOid: c1,
    });
  });

  it("the tie-break is deterministic", async (t) => {
    const idA = `gitop_${ulidA}`;
    const idB = `gitop_${ulidB}`;
    await t.test("rows inserted in ascending id order", async () => {
      assert.deepEqual(await tieBreakVerdict([idA, idB]), {
        expected: true,
        oid: c2,
      });
    });
    await t.test("rows inserted in descending id order", async () => {
      assert.deepEqual(await tieBreakVerdict([idB, idA]), {
        expected: true,
        oid: c2,
      });
    });
  });

  it("an open row is ignored", async () => {
    const storage = makeStorage();
    const ids = createMockIdGenerator({ ulids: [ulidA, ulidB] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    insertOperation(storage, {
      id: ids.mint("gitOperation"),
      intent: "sync",
      state: "open",
      resultHeadOid: null,
      completedAt: null,
    });
    insertOperation(storage, {
      id: ids.mint("gitOperation"),
      intent: "sync",
      state: "complete",
      resultHeadOid: c1,
      completedAt: clock.now(),
    });
    const paths = makePaths();
    const runner = createGitRunner(paths);
    await rewindTo(runner, paths, c1);
    const verdict = await runCheck(storage, runner, {
      gitDir: paths.home,
      repositoryId: fixtureIds.repository,
      ref: "refs/heads/main",
      intent: "sync",
    });
    assert.deepEqual(verdict, { expected: true, oid: c1 });
  });

  it("a completed row that reported no ref value is skipped", async () => {
    const storage = makeStorage();
    const ids = createMockIdGenerator({ ulids: [ulidA, ulidB] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const olderAt = clock.now();
    const newerAt = clock.now();
    insertOperation(storage, {
      id: ids.mint("gitOperation"),
      intent: "sync",
      state: "complete",
      resultHeadOid: c1,
      completedAt: olderAt,
    });
    insertOperation(storage, {
      id: ids.mint("gitOperation"),
      intent: "sync",
      state: "complete",
      resultHeadOid: null,
      outcome: "auth-failed",
      completedAt: newerAt,
    });
    assert.ok(olderAt !== newerAt);
    const paths = makePaths();
    const runner = createGitRunner(paths);
    await rewindTo(runner, paths, c1);
    const verdict = await runCheck(storage, runner, {
      gitDir: paths.home,
      repositoryId: fixtureIds.repository,
      ref: "refs/heads/main",
      intent: "sync",
    });
    assert.deepEqual(verdict, { expected: true, oid: c1 });
  });

  it("a failed operation alone is no baseline", async () => {
    const storage = makeStorage();
    const ids = createMockIdGenerator({ ulids: [ulidA] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    insertOperation(storage, {
      id: ids.mint("gitOperation"),
      intent: "sync",
      state: "complete",
      resultHeadOid: null,
      completedAt: clock.now(),
    });
    const paths = makePaths();
    const runner = createGitRunner(paths);
    await rewindTo(runner, paths, c1);
    const verdict = await runCheck(storage, runner, {
      gitDir: paths.home,
      repositoryId: fixtureIds.repository,
      ref: "refs/heads/main",
      intent: "sync",
    });
    assert.deepEqual(verdict, {
      expected: false,
      expectedOid: null,
      observedOid: c1,
    });
  });

  it("the diagnostic writes nothing", async () => {
    const storage = makeStorage();
    const ids = createMockIdGenerator({ ulids: [ulidA] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    insertOperation(storage, {
      id: ids.mint("gitOperation"),
      intent: "sync",
      state: "complete",
      resultHeadOid: c1,
      completedAt: clock.now(),
    });
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const snapshot = (): unknown =>
      storage.storage.transact((transaction) => ({
        operations: transaction.all(
          "SELECT id, state, outcome, completed_at FROM git_operation ORDER BY id",
        ),
        events: transaction.all(
          "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event ORDER BY id",
        ),
      }));
    const before = snapshot();
    const verdict = await runCheck(storage, runner, {
      gitDir: paths.home,
      repositoryId: fixtureIds.repository,
      ref: "refs/heads/main",
      intent: "sync",
    });
    assert.deepEqual(verdict, {
      expected: false,
      expectedOid: c1,
      observedOid: c2,
    });
    assert.deepEqual(snapshot(), before);
  });
});

async function tieBreakVerdict(
  order: readonly [string, string],
): Promise<OutsideWriterVerdict> {
  const storage = makeStorage();
  const ids = createMockIdGenerator({ ulids: [ulidA, ulidB] });
  const clock = createMockClock({ start: 1700000000000, step: 0 });
  const completedAt = clock.now();
  const idA = ids.mint("gitOperation");
  const idB = ids.mint("gitOperation");
  assert.equal(idA, `gitop_${ulidA}`);
  assert.equal(idB, `gitop_${ulidB}`);
  const byId: Readonly<Record<string, string>> = { [idA]: c1, [idB]: c2 };
  for (const id of order) {
    insertOperation(storage, {
      id,
      intent: "sync",
      state: "complete",
      resultHeadOid: byId[id]!,
      completedAt,
    });
  }
  const paths = makePaths();
  const runner = createGitRunner(paths);
  return runCheck(storage, runner, {
    gitDir: paths.home,
    repositoryId: fixtureIds.repository,
    ref: "refs/heads/main",
    intent: "sync",
  });
}
