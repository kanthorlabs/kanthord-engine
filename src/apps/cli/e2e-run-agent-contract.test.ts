import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { simpleGit } from "simple-git";
import { ExitCode } from "./constants.ts";
import { RunExitCode } from "./run-agent-exit.ts";
import { llmStub, type StubTurn } from "./e2e-llm-stub-test-support.ts";
import {
  buildFixtures,
  resetFixturesAuth,
  spawnCli,
  TEST_K,
  TEST_TIMEOUT_MS,
} from "./e2e-run-agent-test-support.ts";

const ENGINE_ROOT = new URL("../../../", import.meta.url).pathname;
const PROMPT_DIR = join(ENGINE_ROOT, "static", "prompt");

const REDACTION_MARKER = "<redacted:llm_credential:";
const SECRET_EXPOSED_CODE = "cli.run.agent.secret_exposed";
const M4_TEXT = "Repository prompt M4";
const BLOCK_TEXT =
  "The input holds a value of a known credential. No tool receives this value.";
const TOOL_NOT_FOUND_INFIX = " not found";

const SECRET_FILE_CONTENT = `token ${TEST_K}`;
const CONTEXT_CONTENT = `context ${TEST_K}`;
const HTTP_ERROR_STATUS = 400;
const FAILED_END = "failed";
const TERMINAL_CLASS = "terminal";
const PROVIDER_FAIL_EXIT = RunExitCode.Failed;
const DIGEST_HEX_LENGTH = 64;

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

const EVIDENCE_UPLOAD = "evidence-upload";
const BASH_TOOL = "bash";
const PROBE_TOOL = "probe";

const WARN_RULE = "llm_credential";
const WARN_COUNT_AC4 = 2;
const WARN_LINE_COUNT_AC4 = 1;
const ZERO_COUNT = 0;
const TYPEOF_STRING = "string";
const SYSTEM_ROLE = "system";
const ASSISTANT_ROLE_STR = "assistant";
const TOOL_RESULT_ROLE_STR = "toolResult";
const ENTRY_TYPE_MESSAGE = "message";

const COMMIT_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];

function sha256hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function toolNamesOf(requestBody: unknown): string[] {
  const body = requestBody as { tools?: { name: string }[] };
  return (body.tools ?? []).map((t) => t.name).sort();
}

function inputTextsOf(requestBody: unknown): string[] {
  const body = requestBody as {
    input?: { role?: string; content?: string | unknown[] }[];
  };
  return (body.input ?? []).flatMap((m) => {
    if (typeof m.content === TYPEOF_STRING) return [m.content as string];
    if (Array.isArray(m.content))
      return m.content.map((c) => (c as { text?: string }).text ?? "");
    return [];
  });
}

function firstSystemText(requestBody: unknown): string {
  const body = requestBody as {
    input?: { role?: string; content?: string | unknown[] }[];
  };
  const sys = (body.input ?? []).find((m) => m.role === SYSTEM_ROLE);
  if (!sys) return "";
  if (typeof sys.content === TYPEOF_STRING) return sys.content as string;
  return "";
}

function parseO(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8").trim()) as Record<
    string,
    unknown
  >;
}

function parseS(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim());
}

test(
  "L3-AC1: no input entry of a session file holds a known secret",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stubPlaceholder1 = await llmStub(t, [], "");
    const f1 = await buildFixtures(t, stubPlaceholder1.baseUrl);

    const secretFilePath = join(f1.W, "secret.txt");
    writeFileSync(secretFilePath, SECRET_FILE_CONTENT);
    const git1 = simpleGit(f1.W);
    await git1.add(".");
    await git1.raw([...COMMIT_IDENTITY, "commit", "-m", "add secret"]);

    const contextPath = join(f1.TEST, "context.md");
    writeFileSync(contextPath, CONTEXT_CONTENT);

    const turns1: StubTurn[] = [
      {
        kind: "tool_calls",
        calls: [{ name: "read", args: { path: "secret.txt" } }],
      },
      { kind: "text", text: "done-ac1" },
    ];
    const stub1 = await llmStub(t, turns1, "");
    resetFixturesAuth(f1, stub1.baseUrl);

    const result1 = await spawnCli(f1, {
      systemPrompt: [contextPath],
      prompt: [`use ${TEST_K}`],
      signal: t.signal,
    });

    assert.equal(result1.status, ExitCode.Success);

    for (const req of stub1.requests) {
      assert.ok(!JSON.stringify(req.body).includes(TEST_K));
    }

    const req1Texts = inputTextsOf(stub1.requests[0]?.body);
    for (const text of req1Texts) {
      assert.ok(text.includes(REDACTION_MARKER));
    }

    const req2Body = stub1.requests[1]?.body;
    assert.ok(req2Body !== undefined);
    assert.ok(JSON.stringify(req2Body).includes(REDACTION_MARKER));

    const s1Lines = parseS(f1.S);
    for (const line of s1Lines) {
      assert.ok(!line.includes(TEST_K));
    }

    assert.ok(!readFileSync(f1.O, "utf8").includes(TEST_K));
    assert.ok(!result1.stderr.includes(TEST_K));

    const stubPlaceholder2 = await llmStub(t, [], "");
    const f2 = await buildFixtures(t, stubPlaceholder2.baseUrl);

    const secretFilePath2 = join(f2.W, "secret.txt");
    writeFileSync(secretFilePath2, SECRET_FILE_CONTENT);
    const git2 = simpleGit(f2.W);
    await git2.add(".");
    await git2.raw([...COMMIT_IDENTITY, "commit", "-m", "add secret"]);

    const contextPath2 = join(f2.TEST, "context.md");
    writeFileSync(contextPath2, CONTEXT_CONTENT);

    const httpBody = JSON.stringify({
      error: { message: `bad key ${TEST_K}` },
    });
    const turns2: StubTurn[] = [
      { kind: "http_error", status: HTTP_ERROR_STATUS, body: httpBody },
    ];
    const stub2 = await llmStub(t, turns2, "");
    resetFixturesAuth(f2, stub2.baseUrl);

    const result2 = await spawnCli(f2, {
      systemPrompt: [contextPath2],
      prompt: [`use ${TEST_K}`],
      signal: t.signal,
    });

    assert.equal(result2.status, PROVIDER_FAIL_EXIT);

    const o2 = parseO(f2.O);
    assert.equal(o2.end, FAILED_END);
    assert.equal(o2.class, TERMINAL_CLASS);
    assert.ok(o2.failure !== null);
    assert.ok((o2.failure as string).includes(REDACTION_MARKER));

    const s2Lines = parseS(f2.S);
    let foundRedactedError = false;
    for (const line of s2Lines) {
      assert.ok(!line.includes(TEST_K));
      const entry = JSON.parse(line) as Record<string, unknown>;
      const msg = entry.message as Record<string, unknown> | undefined;
      if (
        entry.type === ENTRY_TYPE_MESSAGE &&
        msg?.role === ASSISTANT_ROLE_STR
      ) {
        const em = msg.errorMessage as string | undefined;
        if (em !== undefined && em !== null && em.includes(REDACTION_MARKER)) {
          foundRedactedError = true;
        }
      }
    }
    assert.ok(foundRedactedError);

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
    const sweRoleText = readFileSync(
      join(PROMPT_DIR, "role", "swe@1.md"),
      "utf8",
    );
    const reRoleText = readFileSync(
      join(PROMPT_DIR, "role", "re@1.md"),
      "utf8",
    );
    const envText = readFileSync(join(PROMPT_DIR, "env@1.md"), "utf8");

    function cpOf(profile: string): string {
      const parts: string[] =
        profile === ENV_PROFILE
          ? [baseText, envText, M4_TEXT]
          : profile === SWE_PROFILE
            ? [baseText, codingText, sweRoleText, M4_TEXT]
            : [baseText, codingText, reRoleText, M4_TEXT];
      return parts.join("\n\n");
    }

    for (const profile of [SWE_PROFILE, RE_PROFILE, ENV_PROFILE]) {
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

      const cp = cpOf(profile);
      const digest = sha256hex(cp);
      assert.equal(digest.length, DIGEST_HEX_LENGTH);

      const sysText = firstSystemText(stub.requests[0]?.body);
      assert.ok(sysText.startsWith(cp));

      const o = parseO(fixtures.O);
      assert.equal(o.system_prompt_digest, digest);
    }
  },
);

test(
  "L3-AC3: each profile offers its full tool set and absent tools return not-found",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const sweStub = await llmStub(
      t,
      [
        {
          kind: "tool_calls",
          calls: [{ name: EVIDENCE_UPLOAD, args: { path: "README" } }],
        },
        { kind: "text", text: "done-swe" },
      ],
      "",
    );
    const sweFixtures = await buildFixtures(t, sweStub.baseUrl);

    const sweResult = await spawnCli(sweFixtures, {
      profile: SWE_PROFILE,
      prompt: ["run"],
      signal: t.signal,
    });

    assert.equal(sweResult.status, ExitCode.Success);
    assert.deepEqual(toolNamesOf(sweStub.requests[0]?.body), SWE_TOOLS_SORTED);
    const sweSession = readFileSync(sweFixtures.S, "utf8");
    assert.ok(
      sweSession.includes(`Tool ${EVIDENCE_UPLOAD}${TOOL_NOT_FOUND_INFIX}`),
    );

    const reStub = await llmStub(
      t,
      [
        {
          kind: "tool_calls",
          calls: [{ name: BASH_TOOL, args: { command: "ls" } }],
        },
        { kind: "text", text: "done-re" },
      ],
      "",
    );
    const reFixtures = await buildFixtures(t, reStub.baseUrl);

    const reResult = await spawnCli(reFixtures, {
      profile: RE_PROFILE,
      prompt: ["run"],
      signal: t.signal,
    });

    assert.equal(reResult.status, ExitCode.Success);
    assert.deepEqual(
      toolNamesOf(reStub.requests[0]?.body),
      RE_ENV_TOOLS_SORTED,
    );
    const reSession = readFileSync(reFixtures.S, "utf8");
    assert.ok(reSession.includes(`Tool ${BASH_TOOL}${TOOL_NOT_FOUND_INFIX}`));

    const envStub = await llmStub(
      t,
      [
        {
          kind: "tool_calls",
          calls: [{ name: PROBE_TOOL, args: {} }],
        },
        { kind: "text", text: "done-env" },
      ],
      "",
    );
    const envFixtures = await buildFixtures(t, envStub.baseUrl);

    const envResult = await spawnCli(envFixtures, {
      profile: ENV_PROFILE,
      prompt: ["run"],
      signal: t.signal,
    });

    assert.equal(envResult.status, ExitCode.Success);
    assert.deepEqual(
      toolNamesOf(envStub.requests[0]?.body),
      RE_ENV_TOOLS_SORTED,
    );
    const envSession = readFileSync(envFixtures.S, "utf8");
    assert.ok(envSession.includes(`Tool ${PROBE_TOOL}${TOOL_NOT_FOUND_INFIX}`));
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
      { kind: "text", text: "done-ac4" },
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

    const sessionText = readFileSync(fixtures.S, "utf8");
    const sessionLines = sessionText.split("\n").filter((l) => l.trim());

    let blockCount = ZERO_COUNT;
    let assistantHasK = false;
    for (const line of sessionLines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const msg = entry.message as Record<string, unknown> | undefined;
      if (
        entry.type === ENTRY_TYPE_MESSAGE &&
        msg?.role === ASSISTANT_ROLE_STR
      ) {
        assistantHasK ||= JSON.stringify(msg).includes(TEST_K);
      }
      if (
        entry.type === ENTRY_TYPE_MESSAGE &&
        msg?.role === TOOL_RESULT_ROLE_STR &&
        JSON.stringify(msg).includes(BLOCK_TEXT)
      ) {
        blockCount += 1;
      }
    }
    assert.ok(assistantHasK);
    assert.equal(blockCount, WARN_COUNT_AC4);

    const gitStatus = await (async () => {
      const g = simpleGit(fixtures.W);
      return g.status();
    })();
    assert.equal(gitStatus.files.length, ZERO_COUNT);

    const secretWarnLines = result.stderr.split("\n").filter((l) => {
      try {
        const obj = JSON.parse(l) as Record<string, unknown>;
        return (
          obj.code === SECRET_EXPOSED_CODE &&
          obj.rule === WARN_RULE &&
          obj.count === WARN_COUNT_AC4
        );
      } catch {
        return false;
      }
    });
    assert.equal(secretWarnLines.length, WARN_LINE_COUNT_AC4);

    assert.ok(!readFileSync(fixtures.O, "utf8").includes(TEST_K));
    assert.ok(!result.stdout.includes(TEST_K));
    assert.ok(!result.stderr.includes(TEST_K));
  },
);
