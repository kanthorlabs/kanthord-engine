import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordAcceptance, serializeAcceptanceRecord } from "./acceptance.ts";
import { acceptanceRecordPath, bundleDirectory, runDirectory } from "../tag.ts";
import { RunnerError } from "../errors.ts";
import { main } from "../main.ts";

function dependenciesFor(
  overrides: Partial<{
    readCommit: () => Promise<string>;
    readProposalRevision: () => Promise<string>;
    now: () => Date;
  }> = {},
) {
  return {
    readCommit: overrides.readCommit ?? (async () => "c0ffee"),
    readProposalRevision:
      overrides.readProposalRevision ?? (async () => "dec0de"),
    now: overrides.now ?? (() => new Date("2026-08-09T10:00:00.000Z")),
  };
}

async function withTempCwd<T>(run: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "kanthord-e2e-acceptance-"));
  process.chdir(dir);
  try {
    return await run();
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
}

async function createBundle(tag: string): Promise<void> {
  await mkdir(bundleDirectory(tag, "P1-E1"), { recursive: true });
  await writeFile(
    join(bundleDirectory(tag, "P1-E1"), "bundle.json"),
    "{}",
    "utf8",
  );
}

test("recordAcceptance writes acceptance.json and returns the nine-field record", async () => {
  await withTempCwd(async () => {
    await createBundle("t1");

    const record = await recordAcceptance(dependenciesFor(), {
      tag: "t1",
      by: "Ulrich",
      drive: "confirmed",
      judgment: "accepted",
      noteFile: null,
    });

    assert.deepEqual(record, {
      schemaVersion: 1,
      tag: "t1",
      by: "Ulrich",
      drive: "confirmed",
      judgment: "accepted",
      note: "",
      commit: "c0ffee",
      proposalRevision: "dec0de",
      recordedAt: "2026-08-09T10:00:00.000Z",
    });

    const exists = await readFile(acceptanceRecordPath("t1"), "utf8");
    assert.ok(exists.length > 0);
  });
});

test("the bytes on disk equal serializeAcceptanceRecord, and the parsed key order is the nine names", async () => {
  await withTempCwd(async () => {
    await createBundle("t1");

    const record = await recordAcceptance(dependenciesFor(), {
      tag: "t1",
      by: "Ulrich",
      drive: "confirmed",
      judgment: "accepted",
      noteFile: null,
    });

    const text = await readFile(acceptanceRecordPath("t1"), "utf8");
    assert.equal(text, serializeAcceptanceRecord(record));
    assert.deepEqual(Object.keys(JSON.parse(text) as Record<string, unknown>), [
      "schemaVersion",
      "tag",
      "by",
      "drive",
      "judgment",
      "note",
      "commit",
      "proposalRevision",
      "recordedAt",
    ]);
  });
});

test("a --note-file whose content is 'three faults\\n' stores note verbatim", async () => {
  await withTempCwd(async () => {
    await createBundle("t1");
    const noteFile = join(process.cwd(), "note.txt");
    await writeFile(noteFile, "three faults\n", "utf8");

    const record = await recordAcceptance(dependenciesFor(), {
      tag: "t1",
      by: "Ulrich",
      drive: "confirmed",
      judgment: "rejected",
      noteFile,
    });

    assert.equal(record.note, "three faults\n");
  });
});

test("no bundle under the tag rejects with unavailable, for both an absent run directory and an empty scenario directory", async () => {
  await withTempCwd(async () => {
    try {
      await recordAcceptance(dependenciesFor(), {
        tag: "t1",
        by: "Ulrich",
        drive: "confirmed",
        judgment: "accepted",
        noteFile: null,
      });
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "unavailable");
      assert.equal(error.message, "tag t1 holds no bundle");
    }

    await mkdir(bundleDirectory("t1", "P1-E1"), { recursive: true });

    try {
      await recordAcceptance(dependenciesFor(), {
        tag: "t1",
        by: "Ulrich",
        drive: "confirmed",
        judgment: "accepted",
        noteFile: null,
      });
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "unavailable");
      assert.equal(error.message, "tag t1 holds no bundle");
    }
  });
});

test("a --note-file path that does not exist rejects with invalid-argument, exit 2, naming the path", async () => {
  await withTempCwd(async () => {
    await createBundle("t1");
    const noteFile = join(process.cwd(), "does-not-exist.txt");

    try {
      await recordAcceptance(dependenciesFor(), {
        tag: "t1",
        by: "Ulrich",
        drive: "not-confirmed",
        judgment: "accepted",
        noteFile,
      });
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "invalid-argument");
      assert.equal(error.message, `--note-file ${noteFile} does not exist`);
    }

    const exit = await main(
      [
        "--record-acceptance",
        "--tag",
        "t1",
        "--by",
        "Ulrich",
        "--drive",
        "not-confirmed",
        "--judgment",
        "accepted",
        "--note-file",
        noteFile,
      ],
      { acceptance: dependenciesFor() },
    );
    assert.equal(exit, 2);
  });
});

test("a second call for the same tag rejects with tag-reused, and the file on disk stays byte-identical", async () => {
  await withTempCwd(async () => {
    await createBundle("t1");

    await recordAcceptance(dependenciesFor(), {
      tag: "t1",
      by: "Ulrich",
      drive: "confirmed",
      judgment: "accepted",
      noteFile: null,
    });
    const before = await readFile(acceptanceRecordPath("t1"), "utf8");

    try {
      await recordAcceptance(dependenciesFor(), {
        tag: "t1",
        by: "Ulrich",
        drive: "confirmed",
        judgment: "accepted",
        noteFile: null,
      });
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "tag-reused");
      assert.equal(error.message, "tag t1 already holds an acceptance record");
    }

    const after = await readFile(acceptanceRecordPath("t1"), "utf8");
    assert.equal(after, before);

    const entries = await readdir(runDirectory("t1"));
    assert.ok(entries.includes("acceptance.json"));
  });
});
