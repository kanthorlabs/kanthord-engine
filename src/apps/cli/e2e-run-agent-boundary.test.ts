import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ExitCode } from "./constants.ts";
import { llmStub, type StubTurn } from "./e2e-llm-stub-test-support.ts";
import {
  assertRefused,
  assertRow,
  blockTexts,
  buildFixtures,
  commitAll,
  resetFixturesAuth,
  sessionMessages,
  spawnCli,
  TEST_TIMEOUT_MS,
} from "./e2e-run-agent-test-support.ts";

const AUTH_KEY_COMMAND_CODE = "cli.run.agent.auth_key_command";
const AUTH_IN_PI_DIR_CODE = "cli.run.agent.auth_in_pi_directory";
const PI_AUTH_FILE = "auth.json";
const M6_TEXT = "marker-text-m6-unique-confined-ac14";
const M6_PATTERN = "marker-text-m6-unique-confined-ac1[4]";
const F_CONTENT_AC14 = "content of file F for ac14 test";
const M8_TEXT = "agents md marker m8 unique";
const TOOL_RESULT_ROLE = "toolResult";
const BLOCKED_CALLS = 4;
const ALL_CALLS = 5;

test(
  "L2-AC5: a refused auth file starts nothing and runs no shell code",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stub = await llmStub(t, [], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    const markerPath = join(fixtures.TEST, "marker-ac5.txt");
    resetFixturesAuth(fixtures, stub.baseUrl, `!touch ${markerPath}`);

    const result = await spawnCli(fixtures, {
      prompt: ["run task"],
      signal: t.signal,
    });

    assertRefused(result, AUTH_KEY_COMMAND_CODE);
    assertRow(result.stderr, "field", "key");
    assert.equal(existsSync(markerPath), false);
    assert.deepEqual(stub.requests, []);
    assert.equal(existsSync(fixtures.S), false);
    assert.equal(existsSync(fixtures.O), false);
    assert.deepEqual(readdirSync(fixtures.T), []);
  },
);

test(
  "L2-AC7 variant 1: auth.json in pi directory is refused before tool install",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stub = await llmStub(t, [], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const P = join(fixtures.X, "kanthord", "pi");
    mkdirSync(P, { recursive: true, mode: 0o700 });
    const piAuthFile = join(P, PI_AUTH_FILE);
    writeFileSync(piAuthFile, JSON.stringify({ fake: "entry" }), {
      mode: 0o600,
    });

    const result = await spawnCli(fixtures, {
      prompt: ["run task"],
      signal: t.signal,
    });

    assertRefused(result, AUTH_IN_PI_DIR_CODE);
    assertRow(result.stderr, "path", piAuthFile);
    assert.deepEqual(readdirSync(P), [PI_AUTH_FILE]);
    assert.deepEqual(stub.requests, []);
    assert.equal(existsSync(fixtures.S), false);
    assert.deepEqual(readdirSync(fixtures.T), []);
  },
);

test(
  "L2-AC7 variant 2: workspace extensions and pi dir extensions are not loaded",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: "ok" }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);

    const M7Path = join(fixtures.TEST, "m7-marker.txt");
    const M9Path = join(fixtures.TEST, "m9-marker.txt");

    const extContentW = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(M7Path)}, "loaded");
`;
    const extContentPi = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(M9Path)}, "loaded");
`;

    const extDirW = join(fixtures.W, ".pi", "extensions");
    mkdirSync(extDirW, { recursive: true });
    writeFileSync(join(extDirW, "x.ts"), extContentW);
    writeFileSync(join(fixtures.W, "AGENTS.md"), M8_TEXT);
    await commitAll(fixtures.W, "add extensions");

    const P = join(fixtures.X, "kanthord", "pi");
    const piExtDir = join(P, "extensions");
    mkdirSync(piExtDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(piExtDir, "y.ts"), extContentPi);

    const result = await spawnCli(fixtures, {
      prompt: ["run task"],
      signal: t.signal,
    });

    assert.equal(result.status, ExitCode.Success);
    assert.equal(existsSync(M7Path), false);
    assert.equal(existsSync(M9Path), false);

    assert.ok(stub.requests.length);
    for (const req of stub.requests) {
      assert.ok(!JSON.stringify(req.body).includes(M8_TEXT));
    }
    assert.deepEqual(readdirSync(fixtures.T), []);
  },
);

test(
  "L2-AC14: a confined profile blocks reads outside its workspace root",
  {
    timeout: TEST_TIMEOUT_MS,
  },
  async (t) => {
    const stubPlaceholder = await llmStub(t, [], "");
    const fixtures = await buildFixtures(t, stubPlaceholder.baseUrl);

    const markerPath = join(fixtures.TEST, "m6marker.txt");
    writeFileSync(markerPath, M6_TEXT, { mode: 0o600 });
    writeFileSync(join(fixtures.W, "f.txt"), F_CONTENT_AC14);
    symlinkSync(markerPath, join(fixtures.W, "l.txt"));
    await commitAll(fixtures.W, "add F and L");

    const turns: StubTurn[] = [
      {
        kind: "tool_calls",
        calls: [
          { name: "read", args: { path: markerPath } },
          { name: "grep", args: { pattern: M6_PATTERN, path: fixtures.TEST } },
          {
            name: "read",
            args: { path: join("..", "test", "m6marker.txt") },
          },
          { name: "read", args: { path: "l.txt" } },
          { name: "read", args: { path: "f.txt" } },
        ],
      },
      { kind: "text", text: "done-confined" },
    ];

    const stub = await llmStub(t, turns, "");
    resetFixturesAuth(fixtures, stub.baseUrl);

    const result = await spawnCli(fixtures, {
      profile: "re@1",
      prompt: ["find the marker"],
      signal: t.signal,
    });

    assert.equal(result.status, ExitCode.Success);

    const toolResults = sessionMessages(fixtures.S, TOOL_RESULT_ROLE);
    assert.equal(toolResults.length, ALL_CALLS);
    assert.deepEqual(
      toolResults.map((message) => message.isError),
      [true, true, true, true, false],
    );
    assert.ok(
      blockTexts(toolResults[BLOCKED_CALLS]!).join("").includes(F_CONTENT_AC14),
    );

    assert.ok(stub.requests.length);
    for (const req of stub.requests) {
      assert.ok(!JSON.stringify(req.body).includes(M6_TEXT));
    }
    assert.ok(!readFileSync(fixtures.S, "utf8").includes(M6_TEXT));
    assert.ok(!readFileSync(fixtures.O, "utf8").includes(M6_TEXT));
    assert.deepEqual(readdirSync(fixtures.T), []);
  },
);
