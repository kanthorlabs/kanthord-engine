import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import type { Tools } from "../../../test/helpers/remote/tools.ts";
import {
  fixtureObjectIds,
  seedRepositories,
} from "../../../test/helpers/remote/seed.ts";
import type { SeedRoot } from "../../../test/helpers/remote/seed.ts";

import type { GitPaths } from "./index.ts";
import { createGitRunner } from "./run.ts";
import type { GitRunner } from "./run.ts";
import {
  OBSERVED_OID_PATTERN,
  parseObservedOid,
  refUpdate,
} from "./ref-update.ts";

const tools: Tools = resolveTools();
const c1 = "7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca";
const c2 = "251c92d5a215053aea80432f179653f99072835d";

const directories: string[] = [];

let seeded: SeedRoot;

before(() => {
  seeded = seedRepositories(tools);
});

after(() => {
  seeded?.dispose();
  for (const dir of directories) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makePaths(): GitPaths {
  const dir = mkdtempSync(join(tmpdir(), "kanthord-refupdate-"));
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

function refInput(
  paths: GitPaths,
  ref: string,
  expectedOid: string | null,
  nextOid: string,
): {
  gitDir: string;
  ref: string;
  expectedOid: string | null;
  nextOid: string;
  pidFile: string;
} {
  return {
    gitDir: paths.home,
    ref,
    expectedOid,
    nextOid,
    pidFile: join(paths.home, "ref.pid"),
  };
}

async function revParse(
  runner: GitRunner,
  paths: GitPaths,
  ref: string,
): Promise<string> {
  const result = await runner({
    args: ["--git-dir=" + paths.home, "rev-parse", "--verify", ref],
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

describe("src/services/git/ref-update.test", () => {
  it("the pinned object ids match the fixture", () => {
    assert.equal(fixtureObjectIds.commit1, c1);
    assert.equal(fixtureObjectIds.commit2, c2);
  });

  it("OBSERVED_OID_PATTERN is the documented regex", () => {
    assert.equal(
      OBSERVED_OID_PATTERN.source,
      "\\bis at ([0-9a-f]{40}) but expected ",
    );
  });

  it("parseObservedOid returns the observed id from the update-ref diagnostic", () => {
    const diagnostic =
      "fatal: update_ref failed for ref 'refs/heads/main': cannot lock ref 'refs/heads/main': is at 7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386ca but expected 251c92d5a215053aea80432f179653f99072835d";
    assert.equal(parseObservedOid(diagnostic), c1);
  });

  it("parseObservedOid returns null for the reference already exists diagnostic", () => {
    const diagnostic =
      "fatal: update_ref failed for ref 'refs/heads/main': cannot lock ref 'refs/heads/main': reference already exists";
    assert.equal(parseObservedOid(diagnostic), null);
  });

  it("parseObservedOid returns null for empty input", () => {
    assert.equal(parseObservedOid(""), null);
  });

  it("parseObservedOid refuses a 39-character value", () => {
    const shortValue = "7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386c";
    assert.equal(shortValue.length, 39);
    assert.equal(
      parseObservedOid(`is at ${shortValue} but expected ${c2}`),
      null,
    );
  });

  it("parseObservedOid refuses a value with non-hexadecimal characters", () => {
    const diagnostic =
      "is at 7d3892b1d8a35ff5ed2c0ead044b4e3c9d8386gx but expected 251c92d5a215053aea80432f179653f99072835d";
    assert.equal(parseObservedOid(diagnostic), null);
  });

  it("a matching expected oid updates the ref", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    assert.equal(await revParse(runner, paths, "refs/heads/main"), c2);
    const result = await refUpdate(
      runner,
      refInput(paths, "refs/heads/main", c2, c1),
    );
    assert.deepEqual(result, { updated: true, oid: c1 });
    assert.equal(await revParse(runner, paths, "refs/heads/main"), c1);
  });

  it("a stale expected oid aborts and reports the observed oid", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const result = await refUpdate(
      runner,
      refInput(paths, "refs/heads/main", c1, c1),
    );
    assert.deepEqual(result, { updated: false, observedOid: c2 });
    assert.equal(await revParse(runner, paths, "refs/heads/main"), c2);
  });

  it("a stale expected oid aborts identically when the ref is packed", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const packed = await runner({
      args: ["--git-dir=" + paths.home, "pack-refs", "--all"],
    });
    assert.equal(packed.code, 0, packed.stderr);
    const result = await refUpdate(
      runner,
      refInput(paths, "refs/heads/main", c1, c1),
    );
    assert.deepEqual(result, { updated: false, observedOid: c2 });
    assert.equal(await revParse(runner, paths, "refs/heads/main"), c2);
  });

  it("an empty expected oid creates a missing ref", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const result = await refUpdate(
      runner,
      refInput(paths, "refs/heads/fresh", null, c1),
    );
    assert.deepEqual(result, { updated: true, oid: c1 });
    assert.equal(await revParse(runner, paths, "refs/heads/fresh"), c1);
  });

  it("an empty expected oid against an existing ref fails and reports no observed oid", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const result = await refUpdate(
      runner,
      refInput(paths, "refs/heads/main", null, c1),
    );
    assert.deepEqual(result, { updated: false, observedOid: null });
    assert.equal(await revParse(runner, paths, "refs/heads/main"), c2);
  });

  it("a pre-existing lock fails rather than truncates", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const lockPath = join(paths.home, "refs", "heads", "main.lock");
    writeFileSync(lockPath, "sentinel");
    try {
      const result = await refUpdate(
        runner,
        refInput(paths, "refs/heads/main", c2, c1),
      );
      assert.deepEqual(result, { updated: false, observedOid: null });
      assert.equal(await revParse(runner, paths, "refs/heads/main"), c2);
      assert.equal(readFileSync(lockPath, "utf8"), "sentinel");
    } finally {
      rmSync(lockPath, { force: true });
    }
  });

  it("the pid file reaches the launcher", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const pidFile = join(paths.home, "ref.pid");
    const result = await refUpdate(runner, {
      ...refInput(paths, "refs/heads/main", c2, c1),
      pidFile,
    });
    assert.deepEqual(result, { updated: true, oid: c1 });
    assert.match(readFileSync(pidFile, "utf8"), /^[1-9][0-9]*$/);
  });

  it("no hook runs", async () => {
    const paths = makePaths();
    const runner = createGitRunner(paths);
    const marker = join(paths.home, "hook-ran.txt");
    const hooksDir = join(paths.home, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      join(hooksDir, "reference-transaction"),
      `#!/bin/sh\nprintf '%s\\n' ran > '${marker}'\n`,
      { mode: 0o700 },
    );
    const result = await refUpdate(
      runner,
      refInput(paths, "refs/heads/main", c2, c1),
    );
    assert.deepEqual(result, { updated: true, oid: c1 });
    assert.equal(existsSync(marker), false);
  });
});
