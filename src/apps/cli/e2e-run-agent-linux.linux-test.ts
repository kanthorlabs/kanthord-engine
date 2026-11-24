import assert from "node:assert/strict";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { test } from "node:test";
import { llmStub } from "./e2e-llm-stub-test-support.ts";
import {
  buildFixtures,
  spawnCli,
  TEST_TIMEOUT_MS,
} from "./e2e-run-agent-test-support.ts";
import { nftConnectionSet } from "./e2e-run-agent-linux-test-support.ts";

const execFileAsync = promisify(execFile);

const STUB_TEXT = "ok";
const SUCCESS_EXIT = 0;
const STUB_CALL_COUNT = 1;
const TEST_HOST = "192.0.2.1";
const TEST_PORT = 443;
const CONNECTION_TIMEOUT_MS = 50;
const KANTHORD_E2E_USER = "kanthord-e2e";
const KANTHORD_E2E_HOMEDIR = "/home/kanthord-e2e";

test(
  "stub answers a scripted request on loopback inside the namespace",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const stub = await llmStub(t, [{ kind: "text", text: STUB_TEXT }], "");
    const fixtures = await buildFixtures(t, stub.baseUrl);
    const result = await spawnCli(fixtures, { signal: t.signal });
    assert.equal(result.status, SUCCESS_EXIT);
    assert.equal(stub.requests.length, STUB_CALL_COUNT);
  },
);

test(
  "nft set records a TCP connection attempt to 192.0.2.1:443",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const socket = createConnection(TEST_PORT, TEST_HOST);
    socket.setTimeout(CONNECTION_TIMEOUT_MS);
    await new Promise<void>((resolve) => {
      socket.on("timeout", () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        resolve();
      });
      socket.on("connect", () => {
        socket.destroy();
        resolve();
      });
    });

    const setJson = await nftConnectionSet();
    assert.ok(
      setJson.includes(TEST_HOST),
      `nft set missing ${TEST_HOST}: ${setJson}`,
    );
    assert.ok(
      setJson.includes(String(TEST_PORT)),
      `nft set missing port ${TEST_PORT}: ${setJson}`,
    );
  },
);

test(
  "user database gives kanthord-e2e the homedir /home/kanthord-e2e",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { stdout } = await execFileAsync("sudo", [
      "-n",
      "-u",
      KANTHORD_E2E_USER,
      "python3",
      "-c",
      "import pwd, os; print(pwd.getpwuid(os.getuid()).pw_dir)",
    ]);
    assert.equal(stdout.trim(), KANTHORD_E2E_HOMEDIR);
  },
);

test(
  "sudo allows ip netns, nft, useradd and setfacl",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await execFileAsync("sudo", ["-n", "ip", "netns", "list"]);
    await execFileAsync("sudo", ["-n", "nft", "list", "tables"]);
    await execFileAsync("sudo", ["-n", "useradd", "--help"]);
    await execFileAsync("sudo", ["-n", "setfacl", "--version"]);
  },
);
