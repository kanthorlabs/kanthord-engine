import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordVerify, serializeVerifyRecord } from "./verify.ts";
import { runDirectory, verifyRecordPath } from "../tag.ts";

function dependenciesFor(
  overrides: Partial<{
    run: (argv: readonly string[]) => Promise<number>;
    readCommit: () => Promise<string>;
    readProposalRevision: () => Promise<string>;
    now: () => Date;
  }> = {},
) {
  const dates = [
    new Date("2026-08-09T10:00:00.000Z"),
    new Date("2026-08-09T10:04:00.000Z"),
  ];
  let call = 0;

  return {
    run: overrides.run ?? (async () => 0),
    readCommit: overrides.readCommit ?? (async () => "c0ffee"),
    readProposalRevision:
      overrides.readProposalRevision ?? (async () => "dec0de"),
    now: overrides.now ?? (() => dates[call++] as Date),
  };
}

async function withTempCwd<T>(run: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "kanthord-e2e-verify-"));
  process.chdir(dir);
  try {
    return await run();
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
}

test("recordVerify returns the eight-field record built from its dependencies", async () => {
  await withTempCwd(async () => {
    const record = await recordVerify(dependenciesFor(), "t1");

    assert.deepEqual(record, {
      schemaVersion: 1,
      tag: "t1",
      command: ["pnpm", "run", "verify"],
      exitCode: 0,
      commit: "c0ffee",
      proposalRevision: "dec0de",
      startedAt: "2026-08-09T10:00:00.000Z",
      finishedAt: "2026-08-09T10:04:00.000Z",
    });
  });
});

test("recordVerify writes bytes equal to serializeVerifyRecord, ending with }\\n, in the eight-key declaration order", async () => {
  await withTempCwd(async () => {
    const record = await recordVerify(dependenciesFor(), "t1");
    const text = await readFile(verifyRecordPath("t1"), "utf8");

    assert.equal(text, serializeVerifyRecord(record));
    assert.equal(text.endsWith("}\n"), true);
    assert.deepEqual(Object.keys(JSON.parse(text) as Record<string, unknown>), [
      "schemaVersion",
      "tag",
      "command",
      "exitCode",
      "commit",
      "proposalRevision",
      "startedAt",
      "finishedAt",
    ]);
  });
});

test("recordVerify records a non-zero verify exit status instead of throwing, and still writes the file", async () => {
  await withTempCwd(async () => {
    const record = await recordVerify(
      dependenciesFor({ run: async () => 1 }),
      "t1",
    );

    assert.equal(record.exitCode, 1);
    const text = await readFile(verifyRecordPath("t1"), "utf8");
    assert.equal(JSON.parse(text).exitCode, 1);
  });
});

test("recordVerify passes exactly [npm, run, verify] to run", async () => {
  await withTempCwd(async () => {
    let seen: readonly string[] | undefined;
    await recordVerify(
      dependenciesFor({
        run: async (argv) => {
          seen = argv;
          return 0;
        },
      }),
      "t1",
    );

    assert.deepEqual(seen, ["pnpm", "run", "verify"]);
  });
});

test("recordVerify writes exactly one file, verify.json, under the run directory", async () => {
  await withTempCwd(async () => {
    await recordVerify(dependenciesFor(), "t1");
    const entries = await readdir(runDirectory("t1"));

    assert.deepEqual(entries, ["verify.json"]);
  });
});
