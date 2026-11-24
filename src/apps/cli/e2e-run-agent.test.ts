import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { simpleGit } from "simple-git";
import { ExitCode } from "./constants.ts";
import { llmStub, type StubTurn } from "./e2e-llm-stub-test-support.ts";
import {
  buildFixtures,
  spawnCli,
  TEST_K,
  TEST_TIMEOUT_MS,
} from "./e2e-run-agent-test-support.ts";

const NOTE_CONTENT_AC1 = "note content written by agent for ac1 test";
const PROMPT_AC1 = "add the note";
const DONE_TEXT_AC1 = "done-1";
const END_COMPLETED = "completed";
const EMPTY_OUTPUT = "";
const SESSION_FILE_MODE = 0o600;
const AC1_MODEL_CALLS = 3;
const AC1_TOOL_CALLS = 2;
const ZERO_PRICE = 0;
const SWE_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"];
const TURN_USAGE = { input: 10, output: 2 };
const BUDGET_10M = "10m";
const SYSTEM_ROLE_VALUE = "system";
const USER_ROLE_VALUE = "user";

const AC4_TEXT = `api key ${TEST_K} exposed`;
const REDACTION_PREFIX = "<redacted:llm_credential:";
const SECRET_EXPOSED_CODE = "cli.run.agent.secret_exposed";
const WARN_COUNT_AC4 = 1;

const M3_TEXT = "task prompt text for m3 unique";
const M5_TEXT = "extra prompt part m5 unique";
const M4_CONTEXT_MARKER = "context m4 unique";
const M4_CONTEXT = `Binding prompt of repository r:\n\n${M4_CONTEXT_MARKER}`;

const PROMPT_TEXT_PATH_CODE = "cli.run.agent.prompt_text_path";

const REFUSAL_EXIT = 1;
const AC8_LINE_COUNT = 3;
const COMPLETED_CLASS = "none";

const COMMIT_IDENTITY_AC8 = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];

test(
  "L2-AC1: a run does its work, records it and reports it",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const turns: StubTurn[] = [
      {
        kind: "tool_calls",
        calls: [
          {
            name: "write",
            args: { path: "note.md", content: NOTE_CONTENT_AC1 },
          },
        ],
        usage: TURN_USAGE,
      },
      {
        kind: "tool_calls",
        calls: [{ name: "bash", args: { command: "git status --porcelain" } }],
        usage: TURN_USAGE,
      },
      { kind: "text", text: DONE_TEXT_AC1, usage: TURN_USAGE },
    ];

    const stub = await llmStub(t, turns, "");
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const result1 = await spawnCli(fixtures, {
      prompt: [PROMPT_AC1],
      signal: t.signal,
    });

    assert.equal(result1.status, ExitCode.Success);
    assert.equal(result1.stdout, EMPTY_OUTPUT);
    assert.equal(result1.stderr, EMPTY_OUTPUT);

    const oContent = readFileSync(fixtures.O, "utf8").trimEnd();
    assert.ok(!oContent.includes("\n"));
    const r = JSON.parse(oContent) as Record<string, unknown>;
    assert.equal(r["end"], END_COMPLETED);
    assert.equal(r["class"], COMPLETED_CLASS);
    assert.equal(r["failure"], null);
    assert.deepEqual(r["budget"], { wall_ms: 7200000, usd: null });
    assert.equal(r["model_calls"], AC1_MODEL_CALLS);
    assert.equal(r["tool_calls"], AC1_TOOL_CALLS);
    assert.deepEqual(r["usage"], {
      input: 30,
      output: 6,
      cache_read: 0,
      cache_write: 0,
    });
    assert.equal(r["list_price_usd"], ZERO_PRICE);
    assert.equal(r["text"], DONE_TEXT_AC1);
    assert.equal(r["workspace"], realpathSync(fixtures.W));

    const reqBody = stub.requests[0]!.body as Record<string, unknown>;
    const toolNames = (reqBody["tools"] as Array<{ name: string }>)
      .map((tool) => tool.name)
      .sort();
    assert.deepEqual(toolNames, SWE_TOOL_NAMES);

    const noteContent = readFileSync(join(fixtures.W, "note.md"), "utf8");
    assert.equal(noteContent, NOTE_CONTENT_AC1);

    const gitOut = execSync(`git -C ${fixtures.W} status --porcelain`, {
      encoding: "utf8",
    }).trim();
    assert.ok(gitOut.includes("note.md"));

    assert.equal(lstatSync(fixtures.S).mode & 0o777, SESSION_FILE_MODE);
    const sLines = readFileSync(fixtures.S, "utf8").split("\n").filter(Boolean);
    const sHeader = JSON.parse(sLines[0]!) as { cwd?: string };
    assert.equal(sHeader["cwd"], realpathSync(fixtures.W));
    assert.ok(readFileSync(fixtures.S, "utf8").includes("note.md"));

    assert.deepEqual(readdirSync(fixtures.T), []);

    const stubV2 = await llmStub(
      t,
      [
        {
          kind: "tool_calls",
          calls: [
            {
              name: "write",
              args: { path: "note.md", content: NOTE_CONTENT_AC1 },
            },
          ],
          usage: TURN_USAGE,
        },
        {
          kind: "tool_calls",
          calls: [
            { name: "bash", args: { command: "git status --porcelain" } },
          ],
          usage: TURN_USAGE,
        },
        { kind: "text", text: DONE_TEXT_AC1, usage: TURN_USAGE },
      ],
      "",
    );
    const fixtures2 = await buildFixtures(t, stubV2.baseUrl);

    const result2 = await spawnCli(fixtures2, {
      prompt: [PROMPT_AC1],
      output: false,
      signal: t.signal,
    });

    assert.equal(result2.status, ExitCode.Success);
    assert.ok(result2.stdout.includes("swe@1 completed"));
    assert.ok(result2.stdout.includes("3 model, 2 tool"));
    assert.ok(result2.stdout.includes("30 input, 6 output"));
    assert.ok(result2.stdout.includes(DONE_TEXT_AC1));
    assert.equal(existsSync(fixtures2.O), false);
  },
);

test(
  "L2-AC3: a refused session path starts nothing",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stub = await llmStub(t, [], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const targetFile = join(fixtures.D, "existing-target.txt");
    const targetContent = "known content of target file for ac3";
    writeFileSync(targetFile, targetContent, { mode: 0o600 });

    const symlinkSession = join(fixtures.D, "s-link.jsonl");
    symlinkSync(targetFile, symlinkSession);

    const result = await spawnCli(fixtures, {
      session: symlinkSession,
      prompt: ["run task"],
      signal: t.signal,
    });

    assert.equal(result.status, REFUSAL_EXIT);
    const firstDiagLine = result.stderr
      .split("\n")
      .find((l) => !l.startsWith("{"));
    assert.ok(firstDiagLine !== undefined);
    assert.ok(firstDiagLine.startsWith("cli.run.agent.session_exists"));
    assert.deepEqual(stub.requests, []);
    assert.equal(readFileSync(targetFile, "utf8"), targetContent);
    assert.equal(existsSync(fixtures.O), false);
    assert.deepEqual(readdirSync(fixtures.T), []);
  },
);

test(
  "L2-AC4: LLM output stays unchanged, result is redacted, stderr holds rotate warning",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stub1 = await llmStub(t, [{ kind: "text", text: AC4_TEXT }], "");
    const fixtures1 = await buildFixtures(t, stub1.baseUrl, { key: TEST_K });

    const result1 = await spawnCli(fixtures1, {
      prompt: ["do something"],
      signal: t.signal,
    });

    assert.equal(result1.status, ExitCode.Success);

    const sText1 = readFileSync(fixtures1.S, "utf8");
    assert.ok(sText1.includes(TEST_K));

    const stderrLines1 = result1.stderr.split("\n").filter(Boolean);
    const warnLine1 = stderrLines1.find((l) => l.startsWith("{"));
    assert.ok(warnLine1 !== undefined);
    const warn1 = JSON.parse(warnLine1) as Record<string, unknown>;
    assert.equal(warn1["code"], SECRET_EXPOSED_CODE);
    assert.equal(warn1["count"], WARN_COUNT_AC4);

    const oLine1 = readFileSync(fixtures1.O, "utf8").trimEnd();
    const r1 = JSON.parse(oLine1) as Record<string, unknown>;
    assert.ok(String(r1["text"]).includes(REDACTION_PREFIX));
    assert.ok(!oLine1.includes(TEST_K));
    assert.ok(!result1.stdout.includes(TEST_K));
    assert.ok(!result1.stderr.includes(TEST_K));

    const stub2 = await llmStub(t, [{ kind: "text", text: AC4_TEXT }], "");
    const fixtures2 = await buildFixtures(t, stub2.baseUrl, { key: TEST_K });

    const result2 = await spawnCli(fixtures2, {
      prompt: ["do something"],
      output: false,
      signal: t.signal,
    });

    assert.equal(result2.status, ExitCode.Success);

    const sText2 = readFileSync(fixtures2.S, "utf8");
    assert.ok(sText2.includes(TEST_K));
    assert.ok(result2.stdout.includes(REDACTION_PREFIX));
    assert.ok(!result2.stdout.includes(TEST_K));
    assert.ok(!result2.stderr.includes(TEST_K));
  },
);

test(
  "L2-AC8: one input runs under two profiles and the results compare",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stub = await llmStub(
      t,
      [
        { kind: "text", text: "done-swe-1" },
        { kind: "text", text: "done-re-1" },
        { kind: "text", text: "done-swe-3" },
      ],
      "",
    );
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const taskFile = join(fixtures.TEST, "task.md");
    writeFileSync(taskFile, M3_TEXT);

    const contextFile = join(fixtures.D, "context.md");
    writeFileSync(contextFile, M4_CONTEXT, { mode: 0o600 });

    const W2 = join(fixtures.D, "w2");
    const W3 = join(fixtures.D, "w3");
    mkdirSync(W2);
    mkdirSync(W3);

    const gitW2 = simpleGit(W2);
    await gitW2.raw(["init", "-b", "main"]);
    writeFileSync(join(W2, "README.md"), "workspace");
    await gitW2.add("README.md");
    await gitW2.raw([...COMMIT_IDENTITY_AC8, "commit", "-m", "init"]);

    const gitW3 = simpleGit(W3);
    await gitW3.raw(["init", "-b", "main"]);
    writeFileSync(join(W3, "README.md"), "workspace");
    await gitW3.add("README.md");
    await gitW3.raw([...COMMIT_IDENTITY_AC8, "commit", "-m", "init"]);

    const S2 = join(fixtures.D, "s2.jsonl");
    const S3 = join(fixtures.D, "s3.jsonl");

    const run1 = await spawnCli(fixtures, {
      profile: "swe@1",
      model: "openai-compatible/stub-1:off",
      workspace: fixtures.W,
      session: fixtures.S,
      systemPrompt: [contextFile],
      prompt: [taskFile, M5_TEXT],
      budget: [BUDGET_10M],
      signal: t.signal,
    });

    const run2 = await spawnCli(fixtures, {
      profile: "re@1",
      model: "openai-compatible/stub-1:off",
      workspace: W2,
      session: S2,
      systemPrompt: [contextFile],
      prompt: [taskFile, M5_TEXT],
      budget: [BUDGET_10M],
      signal: t.signal,
    });

    const run3 = await spawnCli(fixtures, {
      profile: "swe@1",
      model: "openai-compatible/stub-1:off",
      workspace: W3,
      session: S3,
      systemPrompt: [contextFile],
      prompt: [taskFile, M5_TEXT],
      budget: [BUDGET_10M],
      signal: t.signal,
    });

    assert.equal(run1.status, ExitCode.Success);
    assert.equal(run2.status, ExitCode.Success);
    assert.equal(run3.status, ExitCode.Success);

    const oLines = readFileSync(fixtures.O, "utf8").trimEnd().split("\n");
    assert.ok(oLines.length === AC8_LINE_COUNT);
    const r1 = JSON.parse(oLines[0]!) as Record<string, unknown>;
    const r2 = JSON.parse(oLines[1]!) as Record<string, unknown>;
    const r3 = JSON.parse(oLines[2]!) as Record<string, unknown>;

    assert.equal(r1["input_digest"], r2["input_digest"]);
    assert.equal(r1["input_digest"], r3["input_digest"]);
    assert.equal(r1["system_prompt_digest"], r3["system_prompt_digest"]);
    assert.notEqual(r1["system_prompt_digest"], r2["system_prompt_digest"]);

    const req1Body = stub.requests[0]!.body as Record<string, unknown>;
    const inputs1 = req1Body["input"] as Array<{
      role: string;
      content: unknown;
    }>;
    const userMsg1 = inputs1.find((m) => m.role === USER_ROLE_VALUE);
    assert.ok(userMsg1 !== undefined);
    assert.ok(JSON.stringify(userMsg1.content).includes(M3_TEXT));
    assert.ok(JSON.stringify(userMsg1.content).includes(M5_TEXT));

    const sysMsg1 = inputs1.find((m) => m.role === SYSTEM_ROLE_VALUE);
    assert.ok(sysMsg1 !== undefined);
    assert.ok(JSON.stringify(sysMsg1.content).includes(M4_CONTEXT_MARKER));
  },
);

test(
  "L2-AC9: a prompt value is text or a file, and a typo is visible",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: "done-ac9" }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const C1 = join(fixtures.D, "c1");
    mkdirSync(C1);
    writeFileSync(join(C1, "task.md"), M3_TEXT);

    const result = await spawnCli(fixtures, {
      prompt: ["task.md", "fix the bug", "typo.md"],
      cwd: C1,
      signal: t.signal,
    });

    assert.equal(result.status, ExitCode.Success);

    const reqBody = stub.requests[0]!.body as Record<string, unknown>;
    const inputs = reqBody["input"] as Array<{
      role: string;
      content: unknown;
    }>;
    const userMsg = inputs.find((m) => m.role === USER_ROLE_VALUE);
    assert.ok(userMsg !== undefined);
    assert.ok(JSON.stringify(userMsg.content).includes(M3_TEXT));
    assert.ok(JSON.stringify(userMsg.content).includes("fix the bug"));
    assert.ok(JSON.stringify(userMsg.content).includes("typo.md"));

    const noticeLine = result.stderr
      .split("\n")
      .find((l) => l.startsWith(PROMPT_TEXT_PATH_CODE));
    assert.ok(noticeLine !== undefined);
    assert.ok(result.stderr.includes("typo.md"));

    const oContent = readFileSync(fixtures.O, "utf8").trimEnd();
    const r = JSON.parse(oContent) as Record<string, unknown>;
    assert.ok(r["input_digest"] !== undefined);
    assert.equal(r["end"], END_COMPLETED);

    assert.deepEqual(readdirSync(fixtures.T), []);
  },
);

test(
  "L2-AC13: the model selection reaches the request unchanged",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const MODEL_ID_AC13 = "org/think:1";
    const LEVEL_HIGH = "high";
    const MODELS_AC13 = JSON.stringify([
      { id: MODEL_ID_AC13, reasoning_levels: ["off", LEVEL_HIGH] },
    ]);

    const stub = await llmStub(t, [{ kind: "text", text: "done-ac13" }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl, {
      models: MODELS_AC13,
    });

    const result = await spawnCli(fixtures, {
      model: `openai-compatible/${MODEL_ID_AC13}:${LEVEL_HIGH}`,
      prompt: ["run task"],
      signal: t.signal,
    });

    assert.equal(result.status, ExitCode.Success);
    assert.equal(result.stderr, EMPTY_OUTPUT);

    const reqBody = stub.requests[0]!.body as Record<string, unknown>;
    assert.equal(reqBody["model"], MODEL_ID_AC13);
    const reasoning = reqBody["reasoning"] as Record<string, unknown>;
    assert.ok(reasoning !== undefined);
    assert.equal(reasoning["effort"], LEVEL_HIGH);

    const oContent = readFileSync(fixtures.O, "utf8").trimEnd();
    const r = JSON.parse(oContent) as Record<string, unknown>;
    assert.equal(r["model"], MODEL_ID_AC13);
    assert.equal(r["reasoning_effort"], LEVEL_HIGH);
    assert.equal(r["end"], END_COMPLETED);

    assert.deepEqual(readdirSync(fixtures.T), []);
  },
);
