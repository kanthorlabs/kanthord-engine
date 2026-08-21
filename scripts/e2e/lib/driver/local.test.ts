import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createLocalDriver, allocateLocalPort } from "./local.ts";
import type { DaemonConfig } from "./index.ts";
import { createLedger } from "../resources.ts";
import { resolveTools } from "../scenario/tools.ts";
import type { ScenarioContext } from "../scenario/context.ts";
import { secrets } from "../redact.ts";

// One ledger shared by every test in this file: `createLocalDriver`'s
// `ensureBinary` memoizes the packed/installed binary at module scope in
// `local.ts`, so releasing a per-test ledger would delete that shared
// binary out from under a later test. Releasing once, after every test in
// the file has run, still reclaims the directory without breaking reuse.
const ledger = createLedger();
after(() => ledger.releaseAll());

function fakeContext(): ScenarioContext {
  return {
    tag: "local-driver-test",
    scenarioId: "P1-E2",
    bundleDirectory: "/tmp/local-driver-test-bundle",
    take: ledger.take,
    sink: { print(): void {}, record(): void {} },
    assert(): void {},
    daemonHost: null,
    clientHost: null,
  };
}

before(
  async () => {
    const driver = await createLocalDriver(fakeContext());
    await driver.deliverBinary("client");
  },
  { timeout: 300000 },
);

function buildConfig(home: string): DaemonConfig {
  return {
    home,
    actor: "e2e-local-driver-test",
    masterKey: Buffer.alloc(32).toString("base64"),
    http: {
      bind: "203.0.113.1",
      port: 0,
      token: "",
      allowedHosts: [],
    },
    tools: resolveTools(),
    attemptLimit: 3,
    leaseTtlMs: 300000,
  };
}

async function homeFromDriver(
  driver: Readonly<{ deliverToken(token: string): Promise<string> }>,
): Promise<string> {
  const tokenPath = await driver.deliverToken("local-driver-test-token");
  return dirname(tokenPath);
}

test("deliverConfig writes the config at <home>/kanthord.config.json, directly under home", async () => {
  const driver = await createLocalDriver(fakeContext());
  const home = await homeFromDriver(driver);
  const config = buildConfig(home);

  const configPath = await driver.deliverConfig(config);

  assert.equal(configPath, join(home, "kanthord.config.json"));
});

test("startDaemonExpectingRefusal spawns the daemon with cwd equal to home", async () => {
  const driver = await createLocalDriver(fakeContext());
  const home = await homeFromDriver(driver);
  const config = buildConfig(home);

  const record = await driver.startDaemonExpectingRefusal(config);

  assert.equal(record.cwd, home);
});

test("startDaemonExpectingRefusal given null delivers no config and writes nothing into home", async () => {
  const driver = await createLocalDriver(fakeContext());
  const home = await homeFromDriver(driver);

  await driver.startDaemonExpectingRefusal(null);

  const entries = await readdir(home, { recursive: true });
  assert.deepEqual(entries.sort(), ["token"]);
});

test("SECURITY: deliverToken holds the delivered value in the shared secret registry", async () => {
  const driver = await createLocalDriver(fakeContext());
  const heldSecret = "local-driver-deliver-token-secret";

  await driver.deliverToken(heldSecret);

  assert.equal(secrets.values().includes(heldSecret), true);
});

test("SECURITY: startDaemon holds the daemon's bearer token in the shared secret registry", async () => {
  const driver = await createLocalDriver(fakeContext());
  const home = await homeFromDriver(driver);
  const port = await allocateLocalPort();
  const heldSecret = "local-driver-start-daemon-secret";

  const config: DaemonConfig = {
    home,
    actor: "e2e-local-driver-test",
    masterKey: Buffer.alloc(32).toString("base64"),
    http: {
      bind: "127.0.0.1",
      port,
      token: heldSecret,
      allowedHosts: [`127.0.0.1:${String(port)}`],
    },
    tools: resolveTools(),
    attemptLimit: 3,
    leaseTtlMs: 300000,
  };

  const handle = await driver.startDaemon(config);
  try {
    assert.equal(secrets.values().includes(heldSecret), true);
  } finally {
    await handle.stop();
  }
});
