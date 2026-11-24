import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ExitCode } from "./constants.ts";
import { llmStub } from "./e2e-llm-stub-test-support.ts";
import { RunExitCode } from "./run-agent-exit.ts";
import {
  type AgentFixtures,
  assertRefused,
  assertRow,
  buildFixtures,
  type CliResult,
  commitAll,
  digestListing,
  porcelainStatus,
  resultLines,
  spawnCli,
  TEST_K,
  TEST_TIMEOUT_MS,
} from "./e2e-run-agent-test-support.ts";

const START_REFUSED_CODE = "cli.run.agent.start_refused";
const BUDGET_UNPRICED_CODE = "cli.run.agent.budget_unpriced";
const PROVIDER_RETRYABLE_CODE = "cli.run.agent.provider_retryable";
const PROVIDER_FAILED_CODE = "cli.run.agent.provider_failed";
const RE_PROFILE = "re@1";
const OK_TEXT = "ok";
const GIT_CLEAN = "git_clean";
const GIT_WORKTREE = "git_worktree";
const REASON_ROW = "reason:";
const OPTION_NAME = "option";
const OPTION_BUDGET = "--budget";
const NO_REQUESTS = 0;
const BUDGET_5S = "5s";
const BUDGET_END = "budget_end";
const END_FAILED = "failed";
const CLASS_TERMINAL = "terminal";
const CLASS_RETRYABLE = "retryable";
const FAILURE_RATE_LIMITED = "rate_limited";
const FAILURE_UNAUTHORIZED = "unauthorized";
const BUDGET_REACHED_WALL = "wall";
const ONE_LINE = 1;
const AC10_RETRY_REQUESTS = 4;
const AC10_SINGLE_REQUEST = 1;
const DURATION_BUDGET_MIN_MS = 5000;
const DURATION_BUDGET_MAX_MS = 30000;

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

test(
  "L2-AC10: wall budget end exits 4 with terminal class",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(
      t,
      [{ kind: "text", text: OK_TEXT, delayMs: 30000 }],
      "",
    );
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const result = await spawnCli(fixtures, {
      budget: [BUDGET_5S],
      signal: t.signal,
    });

    assert.equal(result.status, RunExitCode.BudgetEnd, result.stderr);
    assert.ok(existsSync(fixtures.S));
    assert.deepEqual(readdirSync(fixtures.T), []);
    assert.ok(!result.stderr.includes(TEST_K));
    const lines = resultLines(fixtures.O);
    assert.equal(lines.length, ONE_LINE);
    const r = lines[0]!;
    assert.equal(r["end"], BUDGET_END);
    assert.equal(r["budget_reached"], BUDGET_REACHED_WALL);
    assert.equal(r["class"], CLASS_TERMINAL);
    const duration = r["duration_ms"] as number;
    assert.ok(
      duration >= DURATION_BUDGET_MIN_MS && duration < DURATION_BUDGET_MAX_MS,
      `duration_ms ${duration}`,
    );
    assert.ok(!readFileSync(fixtures.O, "utf8").includes(TEST_K));
  },
);

test(
  "L2-AC10: 429 rate limit exits 75 with retryable class",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [], "", {
      fixedStatus: {
        status: 429,
        body: JSON.stringify({ error: { message: "Too Many Requests" } }),
      },
    });
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const result = await spawnCli(fixtures, { signal: t.signal });

    assert.equal(result.status, RunExitCode.Retryable, result.stderr);
    assert.equal(stub.requests.length, AC10_RETRY_REQUESTS);
    assert.ok(existsSync(fixtures.S));
    assert.deepEqual(readdirSync(fixtures.T), []);
    const lines = resultLines(fixtures.O);
    assert.equal(lines.length, ONE_LINE);
    const r = lines[0]!;
    assert.equal(r["end"], END_FAILED);
    assert.equal(r["class"], CLASS_RETRYABLE);
    assert.equal(r["failure"], FAILURE_RATE_LIMITED);
    assert.ok(
      result.stderr
        .split("\n")
        .some((l) => l.startsWith(PROVIDER_RETRYABLE_CODE)),
      result.stderr,
    );
    assert.ok(!result.stderr.includes(TEST_K));
    assert.ok(!readFileSync(fixtures.O, "utf8").includes(TEST_K));
  },
);

test(
  "L2-AC15: a cost budget on a model with no price starts nothing",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: OK_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const result = await spawnCli(fixtures, {
      budget: ["1usd"],
      signal: t.signal,
    });

    assertRefused(result, BUDGET_UNPRICED_CODE);
    assertRow(result.stderr, OPTION_NAME, OPTION_BUDGET);
    assert.ok(!result.stderr.includes(TEST_K));
    assert.equal(stub.requests.length, NO_REQUESTS);
    assert.equal(existsSync(fixtures.S), false);
    assert.deepEqual(resultLines(fixtures.O), []);
    assert.deepEqual(readdirSync(fixtures.T), []);
  },
);

test(
  "L2-AC10: 401 unauthorized exits 5 with terminal class",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(
      t,
      [
        {
          kind: "http_error",
          status: 401,
          body: JSON.stringify({
            error: { message: `Unauthorized: ${TEST_K}` },
          }),
        },
      ],
      "",
    );
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const result = await spawnCli(fixtures, { signal: t.signal });

    assert.equal(result.status, RunExitCode.Failed, result.stderr);
    assert.equal(stub.requests.length, AC10_SINGLE_REQUEST);
    assert.ok(existsSync(fixtures.S));
    assert.deepEqual(readdirSync(fixtures.T), []);
    const lines = resultLines(fixtures.O);
    assert.equal(lines.length, ONE_LINE);
    const r = lines[0]!;
    assert.equal(r["class"], CLASS_TERMINAL);
    assert.equal(r["failure"], FAILURE_UNAUTHORIZED);
    assert.ok(
      result.stderr.split("\n").some((l) => l.startsWith(PROVIDER_FAILED_CODE)),
      result.stderr,
    );
    assert.ok(!result.stderr.includes(TEST_K));
    assert.ok(!readFileSync(fixtures.O, "utf8").includes(TEST_K));
    assert.ok(!readFileSync(fixtures.S, "utf8").includes(TEST_K));
  },
);
