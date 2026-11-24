import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ExitCode } from "./constants.ts";
import { llmStub } from "./e2e-llm-stub-test-support.ts";
import {
  type AgentFixtures,
  assertRefused,
  buildFixtures,
  type CliResult,
  commitAll,
  digestListing,
  porcelainStatus,
  resultLines,
  spawnCli,
  TEST_TIMEOUT_MS,
} from "./e2e-run-agent-test-support.ts";

const START_REFUSED_CODE = "cli.run.agent.start_refused";
const RE_PROFILE = "re@1";
const OK_TEXT = "ok";
const GIT_CLEAN = "git_clean";
const GIT_WORKTREE = "git_worktree";
const REASON_ROW = "reason:";
const NO_REQUESTS = 0;

function assertStartRefused(
  result: CliResult,
  fixtures: AgentFixtures,
  precondition: string,
): void {
  assertRefused(result, START_REFUSED_CODE);
  const row = result.stderr
    .split("\n")
    .find((line) => line.startsWith(REASON_ROW));
  assert.ok(row !== undefined, result.stderr);
  assert.ok(
    row.slice(REASON_ROW.length).trim().startsWith(`${precondition}:`),
    row,
  );
  assert.deepEqual(resultLines(fixtures.O), []);
  assert.equal(existsSync(fixtures.S), false);
  assert.deepEqual(readdirSync(fixtures.T), []);
}

test(
  "L2-AC12 variant 1: an uncommitted tracked change refuses the start and changes nothing",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: OK_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    writeFileSync(join(fixtures.W, "README.md"), "dirty");
    const statusBefore = await porcelainStatus(fixtures.W);
    const listingBefore = digestListing(fixtures.W);

    const result = await spawnCli(fixtures, { signal: t.signal });

    assertStartRefused(result, fixtures, GIT_CLEAN);
    assert.equal(stub.requests.length, NO_REQUESTS);
    assert.deepEqual(digestListing(fixtures.W), listingBefore);
    assert.equal(await porcelainStatus(fixtures.W), statusBefore);
  },
);

test(
  "L2-AC12 variant 2: an empty directory that is no git worktree refuses the start and changes nothing",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: OK_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    const emptyW = join(fixtures.TEST, "emptyW");
    mkdirSync(emptyW);
    const listingBefore = digestListing(emptyW);

    const result = await spawnCli(fixtures, {
      workspace: emptyW,
      signal: t.signal,
    });

    assertStartRefused(result, fixtures, GIT_WORKTREE);
    assert.equal(stub.requests.length, NO_REQUESTS);
    assert.deepEqual(digestListing(emptyW), listingBefore);
  },
);

test(
  "L3-AC5 variant 1: swe@1 with an uncommitted tracked change refuses with git_clean",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: OK_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    writeFileSync(join(fixtures.W, "README.md"), "dirty");
    const listingBefore = digestListing(fixtures.W);

    const result = await spawnCli(fixtures, { signal: t.signal });

    assertStartRefused(result, fixtures, GIT_CLEAN);
    assert.equal(stub.requests.length, NO_REQUESTS);
    assert.deepEqual(digestListing(fixtures.W), listingBefore);
  },
);

test(
  "L3-AC5 variant 2: swe@1 with an empty directory that is no worktree refuses with git_worktree",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: OK_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    const emptyDir = join(fixtures.TEST, "emptyW");
    mkdirSync(emptyDir);
    const listingBefore = digestListing(emptyDir);

    const result = await spawnCli(fixtures, {
      workspace: emptyDir,
      signal: t.signal,
    });

    assertStartRefused(result, fixtures, GIT_WORKTREE);
    assert.equal(stub.requests.length, NO_REQUESTS);
    assert.deepEqual(digestListing(emptyDir), listingBefore);
  },
);

test(
  "L3-AC5 variant 3: swe@1 with a subdirectory of a worktree refuses with git_worktree",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: OK_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    const srcDir = join(fixtures.W, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "main.txt"), "source");
    await commitAll(fixtures.W, "add src");
    const listingBefore = digestListing(fixtures.W);

    const result = await spawnCli(fixtures, {
      workspace: srcDir,
      signal: t.signal,
    });

    assertStartRefused(result, fixtures, GIT_WORKTREE);
    assert.equal(stub.requests.length, NO_REQUESTS);
    assert.deepEqual(digestListing(fixtures.W), listingBefore);
  },
);

test(
  "L3-AC5 variant 4: re@1 with an empty directory that is no worktree exits 0",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: OK_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    const emptyDir = join(fixtures.TEST, "emptyW4");
    mkdirSync(emptyDir);

    const result = await spawnCli(fixtures, {
      profile: RE_PROFILE,
      workspace: emptyDir,
      signal: t.signal,
    });

    assert.equal(result.status, ExitCode.Success, result.stderr);
    assert.deepEqual(readdirSync(fixtures.T), []);
  },
);

test(
  "L3-AC5 variant 5: re@1 with an uncommitted tracked change exits 0",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: OK_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    writeFileSync(join(fixtures.W, "README.md"), "dirty");

    const result = await spawnCli(fixtures, {
      profile: RE_PROFILE,
      signal: t.signal,
    });

    assert.equal(result.status, ExitCode.Success, result.stderr);
    assert.deepEqual(readdirSync(fixtures.T), []);
  },
);

test(
  "L3-AC5 variant 6: swe@1 with fsmonitor and hook configured exits 0 and runs no hook or fsmonitor command",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: OK_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    const M10 = join(fixtures.TEST, "M10");
    const M11 = join(fixtures.TEST, "M11");

    const fsmonitorScript = join(fixtures.TEST, "fsmonitor");
    writeFileSync(fsmonitorScript, `#!/bin/sh\ntouch "${M10}"\nexit 0\n`);
    chmodSync(fsmonitorScript, 0o755);

    const hookScript = join(fixtures.TEST, "hook");
    writeFileSync(hookScript, `#!/bin/sh\ntouch "${M11}"\nexit 0\n`);
    chmodSync(hookScript, 0o755);

    const hooksDir = join(fixtures.TEST, "hooks");
    mkdirSync(hooksDir);
    copyFileSync(hookScript, join(hooksDir, "post-index-change"));
    chmodSync(join(hooksDir, "post-index-change"), 0o755);

    appendFileSync(
      join(fixtures.W, ".git", "config"),
      `\n[core]\n\tfsmonitor = ${fsmonitorScript}\n\thooksPath = ${hooksDir}\n`,
    );

    const trackedFile = join(fixtures.W, "README.md");
    const now = new Date();
    const later = new Date(now.getTime() + 2000);
    utimesSync(trackedFile, later, later);

    const listingBefore = digestListing(fixtures.W);
    const result = await spawnCli(fixtures, { signal: t.signal });

    assert.equal(result.status, ExitCode.Success, result.stderr);
    assert.deepEqual(readdirSync(fixtures.T), []);
    assert.equal(existsSync(M10), false);
    assert.equal(existsSync(M11), false);
    assert.deepEqual(digestListing(fixtures.W), listingBefore);
  },
);
