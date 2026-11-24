import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ExitCode } from "./constants.ts";
import { RunExitCode } from "./run-agent-exit.ts";
import {
  llmStub,
  type StubToolCall,
  type StubTurn,
} from "./e2e-llm-stub-test-support.ts";
import {
  type AgentFixtures,
  blockTexts,
  buildFixtures,
  commitAll,
  digestListing,
  jsonLines,
  porcelainStatus,
  requestBody,
  resetFixturesAuth,
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
const PROMPT_DIR = join(ENGINE_ROOT, "static", "prompt");

const REDACTION_MARKER = "<redacted:llm_credential:";
const SECRET_EXPOSED_CODE = "cli.run.agent.secret_exposed";
const PROVIDER_FAILED_CODE = "cli.run.agent.provider_failed";
const M4_TEXT = "Repository prompt M4";
const CWD_SECTION = /^\n\n<cwd>\n[^\n]+\n<\/cwd>$/;
const BLOCK_TEXT =
  "The input holds a value of a known credential. No tool receives this value.";

const SECRET_FILE_CONTENT = `token ${TEST_K}`;
const CONTEXT_CONTENT = `context ${TEST_K}`;
const SECRET_PROMPT = `use ${TEST_K}`;
const HTTP_ERROR_STATUS = 400;
const HTTP_ERROR_BODY = JSON.stringify({
  error: { message: `bad key ${TEST_K}` },
});
const FAILED_END = "failed";
const TERMINAL_CLASS = "terminal";
const BAD_REQUEST = "bad_request";
const ERROR_STOP = "error";

const SWE_PROFILE = "swe@1";
const RE_PROFILE = "re@1";
const ENV_PROFILE = "env@1";
const SWE_TOOLS_SORTED = [
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "write",
];
const RE_ENV_TOOLS_SORTED = ["find", "grep", "ls", "read"];

const WARN_RULE = "llm_credential";
const BLOCKED_CALLS = 2;
const RUN1_REQUESTS = 2;
const SINGLE = 1;
const CLEAN_STATUS = "";
const SYSTEM_ROLE = "system";
const USER_ROLE = "user";
const ASSISTANT_ROLE = "assistant";
const TOOL_RESULT_ROLE = "toolResult";
const TOOL_OUTPUT_TYPE = "function_call_output";
const TOOL_CALL_TYPE = "toolCall";

function sha256hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function secretFixtures(t: TestContext): Promise<AgentFixtures> {
  const placeholder = await llmStub(t, [], "");
  const fixtures = await buildFixtures(t, placeholder.baseUrl);
  writeFileSync(join(fixtures.W, "secret.txt"), SECRET_FILE_CONTENT);
  await commitAll(fixtures.W, "add secret");
  writeFileSync(join(fixtures.TEST, "context.md"), CONTEXT_CONTENT);
  return fixtures;
}

function assertNoSecretLine(sessionPath: string): void {
  for (const line of readFileSync(sessionPath, "utf8").split("\n"))
    assert.ok(!line.includes(TEST_K));
}

test(
  "L3-AC1: no input entry of a session file holds a known secret",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const f1 = await secretFixtures(t);
    const stub1 = await llmStub(
      t,
      [
        {
          kind: "tool_calls",
          calls: [{ name: "read", args: { path: "secret.txt" } }],
        },
        { kind: "text", text: "done" },
      ],
      "",
    );
    resetFixturesAuth(f1, stub1.baseUrl);

    const result1 = await spawnCli(f1, {
      systemPrompt: [join(f1.TEST, "context.md")],
      prompt: [SECRET_PROMPT],
      signal: t.signal,
    });

    assert.equal(result1.status, ExitCode.Success);
    assert.equal(stub1.requests.length, RUN1_REQUESTS);
    for (const req of stub1.requests)
      assert.ok(!JSON.stringify(req.body).includes(TEST_K));
    assert.ok(
      roleText(stub1.requests[0], SYSTEM_ROLE).includes(REDACTION_MARKER),
    );
    assert.ok(
      roleText(stub1.requests[0], USER_ROLE).includes(REDACTION_MARKER),
    );
    const readOutput = (requestBody(stub1.requests[1]).input ?? []).find(
      (item) => item.type === TOOL_OUTPUT_TYPE,
    );
    assert.ok(readOutput !== undefined);
    assert.ok(JSON.stringify(readOutput).includes(REDACTION_MARKER));

    assertNoSecretLine(f1.S);
    assert.ok(!readFileSync(f1.O, "utf8").includes(TEST_K));
    assert.ok(!result1.stderr.includes(TEST_K));

    const f2 = await secretFixtures(t);
    const stub2 = await llmStub(
      t,
      [
        {
          kind: "http_error",
          status: HTTP_ERROR_STATUS,
          body: HTTP_ERROR_BODY,
        },
      ],
      "",
    );
    resetFixturesAuth(f2, stub2.baseUrl);

    const result2 = await spawnCli(f2, {
      systemPrompt: [join(f2.TEST, "context.md")],
      prompt: [SECRET_PROMPT],
      signal: t.signal,
    });

    assert.equal(result2.status, RunExitCode.Failed);
    assert.equal(stub2.requests.length, SINGLE);

    const o2 = resultLines(f2.O)[0]!;
    assert.equal(o2["end"], FAILED_END);
    assert.equal(o2["class"], TERMINAL_CLASS);
    assert.equal(o2["failure"], BAD_REQUEST);

    assertNoSecretLine(f2.S);
    const failed = sessionMessages(f2.S, ASSISTANT_ROLE).filter(
      (message) =>
        message.stopReason === ERROR_STOP &&
        message.errorMessage?.includes(REDACTION_MARKER),
    );
    assert.ok(failed.length);

    assert.ok(
      result2.stderr
        .split("\n")
        .some((line) => line.startsWith(`${PROVIDER_FAILED_CODE}:`)),
    );
    assert.ok(result2.stderr.includes(REDACTION_MARKER));
    assert.ok(!readFileSync(f2.O, "utf8").includes(TEST_K));
    assert.ok(!result2.stderr.includes(TEST_K));
  },
);

test(
  "L3-AC2: each profile composes the correct prompt chain",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const baseText = readFileSync(join(PROMPT_DIR, "base.md"), "utf8");
    const codingText = readFileSync(join(PROMPT_DIR, "coding.md"), "utf8");
    const chains: Record<string, string[]> = {
      [SWE_PROFILE]: [
        baseText,
        codingText,
        readFileSync(join(PROMPT_DIR, "role", "swe@1.md"), "utf8"),
        M4_TEXT,
      ],
      [RE_PROFILE]: [
        baseText,
        codingText,
        readFileSync(join(PROMPT_DIR, "role", "re@1.md"), "utf8"),
        M4_TEXT,
      ],
      [ENV_PROFILE]: [
        baseText,
        readFileSync(join(PROMPT_DIR, "env@1.md"), "utf8"),
        M4_TEXT,
      ],
    };

    for (const [profile, parts] of Object.entries(chains)) {
      const stub = await llmStub(t, [{ kind: "text", text: "ok" }], "");
      const fixtures = await buildFixtures(t, stub.baseUrl);

      const contextPath = join(fixtures.TEST, "context.md");
      writeFileSync(contextPath, M4_TEXT);

      const result = await spawnCli(fixtures, {
        profile,
        systemPrompt: [contextPath],
        prompt: ["run"],
        signal: t.signal,
      });

      assert.equal(result.status, ExitCode.Success);

      const composed = parts.join("\n\n");
      const systemText = roleText(stub.requests[0], SYSTEM_ROLE);
      assert.ok(systemText.startsWith(composed));
      assert.match(systemText.slice(composed.length), CWD_SECTION);
      assert.equal(
        resultLines(fixtures.O)[0]!["system_prompt_digest"],
        sha256hex(composed),
      );
    }
  },
);

interface AbsentToolCase {
  profile: string;
  call: StubToolCall;
  tools: string[];
  unchangedWorkspace: boolean;
}

const ABSENT_TOOL_CASES: AbsentToolCase[] = [
  {
    profile: SWE_PROFILE,
    call: { name: "evidence-upload", args: { path: "README" } },
    tools: SWE_TOOLS_SORTED,
    unchangedWorkspace: false,
  },
  {
    profile: RE_PROFILE,
    call: { name: "bash", args: { command: "ls" } },
    tools: RE_ENV_TOOLS_SORTED,
    unchangedWorkspace: true,
  },
  {
    profile: ENV_PROFILE,
    call: { name: "probe", args: {} },
    tools: RE_ENV_TOOLS_SORTED,
    unchangedWorkspace: true,
  },
];

test(
  "L3-AC3: each profile offers its full tool set and absent tools return not-found",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    for (const item of ABSENT_TOOL_CASES) {
      const stub = await llmStub(
        t,
        [
          { kind: "tool_calls", calls: [item.call] },
          { kind: "text", text: "done" },
        ],
        "",
      );
      const fixtures = await buildFixtures(t, stub.baseUrl);
      const before = digestListing(fixtures.W);

      const result = await spawnCli(fixtures, {
        profile: item.profile,
        prompt: ["run"],
        signal: t.signal,
      });

      assert.equal(result.status, ExitCode.Success);
      assert.deepEqual(toolNames(stub.requests[0]), item.tools);
      const toolResults = sessionMessages(fixtures.S, TOOL_RESULT_ROLE);
      assert.equal(toolResults.length, SINGLE);
      assert.equal(toolResults[0]!.isError, true);
      assert.deepEqual(blockTexts(toolResults[0]!), [
        `Tool ${item.call.name} not found`,
      ]);
      if (item.unchangedWorkspace)
        assert.deepEqual(digestListing(fixtures.W), before);
    }
  },
);

test(
  "L3-AC4: a known secret in a tool input blocks the call and keeps the model output",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stubPlaceholder = await llmStub(t, [], "");
    const fixtures = await buildFixtures(t, stubPlaceholder.baseUrl);
    const leakPath = join(fixtures.TEST, "leak");
    const turns: StubTurn[] = [
      {
        kind: "tool_calls",
        calls: [
          {
            name: "bash",
            args: { command: `printf %s ${TEST_K} > $TEST/leak` },
          },
          { name: "write", args: { path: "leak.txt", content: TEST_K } },
        ],
      },
      { kind: "text", text: "done" },
    ];
    const stub = await llmStub(t, turns, fixtures.TEST);
    resetFixturesAuth(fixtures, stub.baseUrl);

    const result = await spawnCli(fixtures, {
      prompt: ["run"],
      signal: t.signal,
    });

    assert.equal(result.status, ExitCode.Success);
    assert.equal(existsSync(leakPath), false);
    assert.equal(existsSync(join(fixtures.W, "leak.txt")), false);
    assert.equal(await porcelainStatus(fixtures.W), CLEAN_STATUS);

    const toolResults = sessionMessages(fixtures.S, TOOL_RESULT_ROLE);
    assert.equal(toolResults.length, BLOCKED_CALLS);
    for (const message of toolResults)
      assert.deepEqual(blockTexts(message), [BLOCK_TEXT]);

    const toolCalls = sessionEntries(fixtures.S).flatMap((entry) =>
      entry.message?.role === ASSISTANT_ROLE &&
      Array.isArray(entry.message.content)
        ? entry.message.content.filter((block) => block.type === TOOL_CALL_TYPE)
        : [],
    );
    assert.deepEqual(
      toolCalls.map((block) => block.arguments),
      [
        { command: `printf %s ${TEST_K} > ${leakPath}` },
        { path: "leak.txt", content: TEST_K },
      ],
    );

    const warnings = jsonLines(result.stderr, SECRET_EXPOSED_CODE);
    assert.equal(warnings.length, SINGLE);
    assert.equal(warnings[0]!["rule"], WARN_RULE);
    assert.equal(warnings[0]!["count"], BLOCKED_CALLS);

    assert.ok(!readFileSync(fixtures.O, "utf8").includes(TEST_K));
    assert.ok(!result.stdout.includes(TEST_K));
    assert.ok(!result.stderr.includes(TEST_K));
  },
);
