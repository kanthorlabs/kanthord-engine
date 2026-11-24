import assert from "node:assert/strict";
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
import { digest } from "../../kernel/json.ts";
import { ExitCode } from "./constants.ts";
import { llmStub, type StubTurn } from "./e2e-llm-stub-test-support.ts";
import {
  addWorktree,
  assertRefused,
  blockTexts,
  buildFixtures,
  jsonLines,
  porcelainStatus,
  requestBody,
  resultLines,
  roleText,
  sessionEntries,
  sessionMessages,
  spawnCli,
  TEST_K,
  TEST_TIMEOUT_MS,
  toolNames,
} from "./e2e-run-agent-test-support.ts";

const ENGINE_ROOT = new URL("../../../", import.meta.url).pathname;
const ROLE_DIR = join(ENGINE_ROOT, "static", "prompt", "role");

const NOTE_CONTENT_AC1 = "note content written by agent for ac1 test";
const PROMPT_AC1 = "add the note";
const DONE_TEXT_AC1 = "done-1";
const NOTE_STATUS = "?? note.md";
const END_COMPLETED = "completed";
const EMPTY_OUTPUT = "";
const SESSION_FILE_MODE = 0o600;
const MODE_MASK = 0o777;
const AC1_MODEL_CALLS = 3;
const AC1_TOOL_CALLS = 2;
const ZERO_PRICE = 0;
const ONE_LINE = 1;
const DEFAULT_BUDGET = { wall_ms: 7200000, usd: null };
const AC1_USAGE = { input: 30, output: 6, cache_read: 0, cache_write: 0 };
const RESULT_FIELDS = [
  "agent",
  "engine_version",
  "provider",
  "model",
  "reasoning_effort",
  "budget",
  "budget_reached",
  "input_digest",
  "system_prompt_digest",
  "workspace",
  "session",
  "end",
  "class",
  "failure",
  "duration_ms",
  "model_calls",
  "tool_calls",
  "usage",
  "list_price_usd",
  "text",
];
const SWE_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"];
const TURN_USAGE = { input: 10, output: 2 };
const DURATION_ROW = /^ {2}duration {3}\d+\.\d s$/;
const DURATION_ROW_INDEX = 5;
const BUDGET_10M = "10m";
const SYSTEM_ROLE = "system";
const USER_ROLE = "user";
const ASSISTANT_ROLE = "assistant";
const TOOL_RESULT_ROLE = "toolResult";
const BASH_TOOL = "bash";
const STUB_PROVIDER = "openai-compatible";
const STUB_MODEL = "stub-1";
const LEVEL_OFF = "off";

const AC4_TEXT = `api key ${TEST_K} exposed`;
const AC4_REDACTED = /^api key <redacted:llm_credential:[^>]+> exposed$/;
const SECRET_EXPOSED_CODE = "cli.run.agent.secret_exposed";
const SECRET_RULE = "llm_credential";
const WARN_COUNT_AC4 = 1;

const M3_TEXT = "task prompt text for m3 unique";
const M5_TEXT = "extra prompt part m5 unique";
const M4_CONTEXT = "Binding prompt of repository r:\n\ncontext m4 unique";
const AC8_USER_TEXT = `${M3_TEXT}\n\n${M5_TEXT}`;
const AC8_LINE_COUNT = 3;
const SWE_PROFILE = "swe@1";
const RE_PROFILE = "re@1";

const FIX_TEXT = "fix the bug";
const TYPO_VALUE = "typo.md";
const AC9_USER_TEXT = `${M3_TEXT}\n\n${FIX_TEXT}\n\n${TYPO_VALUE}`;
const PROMPT_TEXT_PATH_CODE = "cli.run.agent.prompt_text_path";
const PROMPT_OPTION = "--prompt";
const TYPO_INDEX = 3;

const SESSION_EXISTS_CODE = "cli.run.agent.session_exists";

function ac1Turns(): StubTurn[] {
  return [
    {
      kind: "tool_calls",
      calls: [
        { name: "write", args: { path: "note.md", content: NOTE_CONTENT_AC1 } },
      ],
      usage: TURN_USAGE,
    },
    {
      kind: "tool_calls",
      calls: [{ name: BASH_TOOL, args: { command: "git status --porcelain" } }],
      usage: TURN_USAGE,
    },
    { kind: "text", text: DONE_TEXT_AC1, usage: TURN_USAGE },
  ];
}

test(
  "L2-AC1: a run does its work, records it and reports it",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stub = await llmStub(t, ac1Turns(), "");
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const result1 = await spawnCli(fixtures, {
      prompt: [PROMPT_AC1],
      signal: t.signal,
    });

    assert.equal(result1.status, ExitCode.Success);
    assert.equal(result1.stdout, EMPTY_OUTPUT);
    assert.equal(result1.stderr, EMPTY_OUTPUT);

    const lines = resultLines(fixtures.O);
    assert.equal(lines.length, ONE_LINE);
    const r = lines[0]!;
    assert.deepEqual(Object.keys(r), RESULT_FIELDS);
    assert.equal(r["end"], END_COMPLETED);
    assert.equal(r["class"], null);
    assert.equal(r["failure"], null);
    assert.deepEqual(r["budget"], DEFAULT_BUDGET);
    assert.equal(r["model_calls"], AC1_MODEL_CALLS);
    assert.equal(r["tool_calls"], AC1_TOOL_CALLS);
    assert.deepEqual(r["usage"], AC1_USAGE);
    assert.equal(r["list_price_usd"], ZERO_PRICE);
    assert.equal(r["text"], DONE_TEXT_AC1);
    assert.equal(r["workspace"], realpathSync(fixtures.W));

    assert.deepEqual(toolNames(stub.requests[0]), SWE_TOOL_NAMES);

    assert.equal(
      readFileSync(join(fixtures.W, "note.md"), "utf8"),
      NOTE_CONTENT_AC1,
    );
    assert.equal(await porcelainStatus(fixtures.W), NOTE_STATUS);

    assert.equal(lstatSync(fixtures.S).mode & MODE_MASK, SESSION_FILE_MODE);
    assert.equal(sessionEntries(fixtures.S)[0]!.cwd, realpathSync(fixtures.W));
    const users = sessionMessages(fixtures.S, USER_ROLE);
    assert.equal(users.length, ONE_LINE);
    assert.deepEqual(blockTexts(users[0]!), [PROMPT_AC1]);
    assert.equal(
      sessionMessages(fixtures.S, ASSISTANT_ROLE).length,
      AC1_MODEL_CALLS,
    );
    const toolResults = sessionMessages(fixtures.S, TOOL_RESULT_ROLE);
    assert.equal(toolResults.length, AC1_TOOL_CALLS);
    const bashResult = toolResults.find((m) => m.toolName === BASH_TOOL);
    assert.ok(bashResult !== undefined);
    assert.ok(blockTexts(bashResult).join("").includes(NOTE_STATUS));

    assert.deepEqual(readdirSync(fixtures.T), []);

    const stubV2 = await llmStub(t, ac1Turns(), "");
    const fixtures2 = await buildFixtures(t, stubV2.baseUrl);

    const result2 = await spawnCli(fixtures2, {
      prompt: [PROMPT_AC1],
      output: false,
      signal: t.signal,
    });

    assert.equal(result2.status, ExitCode.Success);
    const layout = result2.stdout.split("\n");
    assert.match(layout[DURATION_ROW_INDEX]!, DURATION_ROW);
    layout.splice(DURATION_ROW_INDEX, ONE_LINE);
    assert.deepEqual(layout, [
      "swe@1 completed",
      "  model      openai-compatible/stub-1:off",
      "  exit       0",
      "  class      none",
      "  budget     2h wall (default)",
      "  calls      3 model, 2 tool",
      "  tokens     30 input, 6 output, 0 cache read, 0 cache write",
      "  list price 0.000000 usd",
      `  session    ${fixtures2.S}`,
      `  workspace  ${realpathSync(fixtures2.W)}`,
      "",
      DONE_TEXT_AC1,
      "",
    ]);
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

    const targetFile = join(fixtures.TEST, "existing-target.txt");
    const targetContent = "known content of target file for ac3";
    writeFileSync(targetFile, targetContent, { mode: 0o600 });
    symlinkSync(targetFile, fixtures.S);

    const result = await spawnCli(fixtures, {
      prompt: ["run task"],
      signal: t.signal,
    });

    assertRefused(result, SESSION_EXISTS_CODE);
    assert.deepEqual(stub.requests, []);
    assert.equal(readFileSync(targetFile, "utf8"), targetContent);
    assert.ok(lstatSync(fixtures.S).isSymbolicLink());
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
    const fixtures1 = await buildFixtures(t, stub1.baseUrl);

    const result1 = await spawnCli(fixtures1, {
      prompt: ["do something"],
      signal: t.signal,
    });

    assert.equal(result1.status, ExitCode.Success);
    const assistants1 = sessionMessages(fixtures1.S, ASSISTANT_ROLE);
    assert.equal(assistants1.length, ONE_LINE);
    assert.deepEqual(blockTexts(assistants1[0]!), [AC4_TEXT]);

    const warnings1 = jsonLines(result1.stderr, SECRET_EXPOSED_CODE);
    assert.equal(warnings1.length, ONE_LINE);
    assert.equal(warnings1[0]!["rule"], SECRET_RULE);
    assert.equal(warnings1[0]!["count"], WARN_COUNT_AC4);

    const oText1 = readFileSync(fixtures1.O, "utf8");
    assert.match(String(resultLines(fixtures1.O)[0]!["text"]), AC4_REDACTED);
    assert.ok(!oText1.includes(TEST_K));
    assert.ok(!result1.stdout.includes(TEST_K));
    assert.ok(!result1.stderr.includes(TEST_K));

    const stub2 = await llmStub(t, [{ kind: "text", text: AC4_TEXT }], "");
    const fixtures2 = await buildFixtures(t, stub2.baseUrl);

    const result2 = await spawnCli(fixtures2, {
      prompt: ["do something"],
      output: false,
      signal: t.signal,
    });

    assert.equal(result2.status, ExitCode.Success);
    const assistants2 = sessionMessages(fixtures2.S, ASSISTANT_ROLE);
    assert.equal(assistants2.length, ONE_LINE);
    assert.deepEqual(blockTexts(assistants2[0]!), [AC4_TEXT]);

    const warnings2 = jsonLines(result2.stderr, SECRET_EXPOSED_CODE);
    assert.equal(warnings2.length, ONE_LINE);
    assert.equal(warnings2[0]!["rule"], SECRET_RULE);
    assert.equal(warnings2[0]!["count"], WARN_COUNT_AC4);

    assert.match(result2.stdout.trimEnd().split("\n").at(-1)!, AC4_REDACTED);
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
        { kind: "text", text: "ok" },
        { kind: "text", text: "ok" },
        { kind: "text", text: "ok" },
      ],
      "",
    );
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const taskFile = join(fixtures.TEST, "task.md");
    writeFileSync(taskFile, M3_TEXT);
    const contextFile = join(fixtures.TEST, "context.md");
    writeFileSync(contextFile, M4_CONTEXT);

    const W2 = join(fixtures.TEST, "w2");
    const W3 = join(fixtures.TEST, "w3");
    await addWorktree(fixtures.W, W2);
    await addWorktree(fixtures.W, W3);

    const runs = [
      { profile: SWE_PROFILE, workspace: fixtures.W, session: fixtures.S },
      {
        profile: RE_PROFILE,
        workspace: W2,
        session: join(fixtures.D, "s2.jsonl"),
      },
      {
        profile: SWE_PROFILE,
        workspace: W3,
        session: join(fixtures.D, "s3.jsonl"),
      },
    ];
    for (const run of runs) {
      const result = await spawnCli(fixtures, {
        ...run,
        systemPrompt: [contextFile],
        prompt: [taskFile, M5_TEXT],
        budget: [BUDGET_10M],
        signal: t.signal,
      });
      assert.equal(result.status, ExitCode.Success);
    }

    const lines = resultLines(fixtures.O);
    assert.equal(lines.length, AC8_LINE_COUNT);
    const [r1, r2, r3] = lines;
    assert.equal(r1!["input_digest"], r2!["input_digest"]);
    assert.equal(r1!["input_digest"], r3!["input_digest"]);
    assert.equal(r1!["system_prompt_digest"], r3!["system_prompt_digest"]);
    assert.notEqual(r1!["system_prompt_digest"], r2!["system_prompt_digest"]);
    assert.notEqual(r1!["workspace"], r3!["workspace"]);

    assert.equal(stub.requests.length, AC8_LINE_COUNT);
    runs.forEach((run, index) => {
      const request = stub.requests[index];
      assert.equal(roleText(request, USER_ROLE), AC8_USER_TEXT);
      const system = roleText(request, SYSTEM_ROLE);
      const role = readFileSync(join(ROLE_DIR, `${run.profile}.md`), "utf8");
      assert.ok(system.includes(role));
      assert.ok(
        system.indexOf(M4_CONTEXT) >= system.indexOf(role) + role.length,
      );
    });
  },
);

test(
  "L2-AC9: a prompt value is text or a file, and a typo is visible",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: "ok" }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const C1 = join(fixtures.TEST, "c1");
    mkdirSync(C1);
    writeFileSync(join(C1, "task.md"), M3_TEXT);

    const result = await spawnCli(fixtures, {
      prompt: ["task.md", FIX_TEXT, TYPO_VALUE],
      cwd: C1,
      signal: t.signal,
    });

    assert.equal(result.status, ExitCode.Success);
    assert.equal(roleText(stub.requests[0], USER_ROLE), AC9_USER_TEXT);

    const notices = jsonLines(result.stderr, PROMPT_TEXT_PATH_CODE);
    assert.equal(notices.length, ONE_LINE);
    assert.equal(notices[0]!["option"], PROMPT_OPTION);
    assert.equal(notices[0]!["index"], TYPO_INDEX);
    assert.ok(!result.stderr.includes(TYPO_VALUE));

    assert.equal(
      resultLines(fixtures.O)[0]!["input_digest"],
      digest({
        prompt: [M3_TEXT, FIX_TEXT, TYPO_VALUE],
        system_prompt: [],
        provider: STUB_PROVIDER,
        model: STUB_MODEL,
        reasoning_effort: LEVEL_OFF,
        budget: DEFAULT_BUDGET,
      }),
    );

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
      { id: MODEL_ID_AC13, reasoning_levels: [LEVEL_OFF, LEVEL_HIGH] },
    ]);

    const stub = await llmStub(t, [{ kind: "text", text: "ok" }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl, {
      models: MODELS_AC13,
    });

    const result = await spawnCli(fixtures, {
      model: `${STUB_PROVIDER}/${MODEL_ID_AC13}:${LEVEL_HIGH}`,
      prompt: ["run task"],
      signal: t.signal,
    });

    assert.equal(result.status, ExitCode.Success);
    assert.equal(result.stderr, EMPTY_OUTPUT);

    const body = requestBody(stub.requests[0]);
    assert.equal(body.model, MODEL_ID_AC13);
    assert.equal(body.reasoning?.["effort"], LEVEL_HIGH);

    const r = resultLines(fixtures.O)[0]!;
    assert.equal(r["model"], MODEL_ID_AC13);
    assert.equal(r["reasoning_effort"], LEVEL_HIGH);
    assert.equal(r["end"], END_COMPLETED);

    assert.deepEqual(readdirSync(fixtures.T), []);
  },
);
