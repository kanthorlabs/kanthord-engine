import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { llmStub } from "./e2e-llm-stub-test-support.ts";
import {
  buildFixtures,
  ENGINE_ROOT,
  spawnCli,
  TEST_TIMEOUT_MS,
} from "./e2e-run-agent-test-support.ts";
import {
  nftConnections,
  spawnBinAsTestUser,
  TEST_USER,
  TEST_USER_HOME,
  writeFileAsTestUser,
} from "./e2e-run-agent-linux-test-support.ts";

const execFileAsync = promisify(execFile);

const STUB_TEXT = "ok";
const SUCCESS_EXIT = 0;
const EMPTY_OUTPUT = "";
const STUB_CALL_COUNT = 1;
const LOOPBACK = "127.0.0.1";
const TEST_HOST = "192.0.2.1";
const TEST_PORT = 443;
const HOMEDIR_SCRIPT =
  'process.stdout.write(require("node:os").userInfo().homedir)';
const PI_TOOLS = ["fd", "rg"];
const PI_TOOLS_BIN = join(
  ENGINE_ROOT,
  ".pi-tools",
  `${process.platform}-${process.arch}`,
  "bin",
);
const FIXTURE_DIRECTORY = join(TEST_USER_HOME, ".kanthord-self-test");
const FIXTURE_PATH = join(FIXTURE_DIRECTORY, "nested", "fixture.json");
const FIXTURE_TEXT = '{"fixture":true}';
const FIXTURE_STAT = `600 ${TEST_USER}`;

function asTestUser(command: string[]): Promise<{ stdout: string }> {
  return execFileAsync("sudo", ["-n", "-u", TEST_USER, ...command]);
}

test(
  "stub answers a scripted request on loopback inside the namespace and the set holds its address and port",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: STUB_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    const result = await spawnCli(fixtures, { signal: t.signal });
    assert.equal(result.status, SUCCESS_EXIT, result.stderr);
    assert.equal(stub.requests.length, STUB_CALL_COUNT);
    const connections = await nftConnections();
    assert.ok(
      connections.some(
        ({ address, port }) =>
          address === LOOPBACK && port === Number(new URL(stub.baseUrl).port),
      ),
      JSON.stringify(connections),
    );
  },
);

test(
  "a connection to 192.0.2.1:443 fails and the set holds its address and port",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const socket = createConnection(TEST_PORT, TEST_HOST);
    await assert.rejects(once(socket, "connect"));
    socket.destroy();

    const connections = await nftConnections();
    assert.ok(
      connections.some(
        ({ address, port }) => address === TEST_HOST && port === TEST_PORT,
      ),
      JSON.stringify(connections),
    );
  },
);

test(
  "os.userInfo().homedir of the test user is /home/kanthord-e2e",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { stdout } = await asTestUser([
      process.execPath,
      "-e",
      HOMEDIR_SCRIPT,
    ]);
    assert.equal(stdout, TEST_USER_HOME);
  },
);

test(
  "the test user starts bin/kanthord.mjs with an explicit environment",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const result = await spawnBinAsTestUser({
      args: ["--version"],
      env: { HOME: TEST_USER_HOME },
      signal: t.signal,
    });
    assert.equal(result.status, SUCCESS_EXIT, result.stderr);
    assert.equal(result.stderr, EMPTY_OUTPUT);
    assert.notEqual(result.stdout, EMPTY_OUTPUT);
  },
);

test(
  "the test user reads and executes each pi tool",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    for (const tool of PI_TOOLS) {
      const path = join(PI_TOOLS_BIN, tool);
      await asTestUser(["test", "-r", path, "-a", "-x", path]);
    }
  },
);

test(
  "a fixture file of the test user has the mode 0600 and the given text",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    t.after(() => asTestUser(["rm", "-rf", FIXTURE_DIRECTORY]));
    await writeFileAsTestUser(FIXTURE_PATH, FIXTURE_TEXT);
    const stat = await asTestUser(["stat", "-c", "%a %U", FIXTURE_PATH]);
    assert.equal(stat.stdout.trim(), FIXTURE_STAT);
    const text = await asTestUser(["cat", FIXTURE_PATH]);
    assert.equal(text.stdout, FIXTURE_TEXT);
  },
);
