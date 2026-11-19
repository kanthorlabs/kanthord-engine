import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { directories } from "../kernel/xdg.ts";
import { temporary } from "../kernel/test-support.ts";
import { createBashSandbox } from "./bash-sandbox.ts";
import { piAgentDirectory } from "./pi.ts";

const TWICE = 2;
const ONCE = 1;
const NO_RESETS = 0;
const COMMAND = "echo hi";

function fakeRuntime(options: { initialize?: () => Promise<void> } = {}) {
  const calls: {
    command: string;
    binShell: string | undefined;
    customConfig: {
      filesystem?: {
        allowWrite: string[];
        denyRead: string[];
        denyWrite: string[];
      };
      network?: {
        allowedDomains: string[];
        deniedDomains: string[];
        allowLocalBinding?: boolean;
      };
    };
  }[] = [];
  const initialized: unknown[] = [];
  let resets = 0;
  return {
    calls,
    initialized,
    resets: () => resets,
    runtime: {
      initialize: async (config: unknown) => {
        initialized.push(config);
        await options.initialize?.();
      },
      wrapWithSandbox: async (
        command: string,
        binShell?: string,
        customConfig: (typeof calls)[number]["customConfig"] = {},
      ) => {
        calls.push({ command, binShell, customConfig });
        return `sandboxed ${command}`;
      },
      reset: async () => {
        resets += ONCE;
      },
    },
  };
}

test("a wrap passes the cwd and the temporary directory as allowWrite and the denyRead list", async (t) => {
  const cwd = temporary(t);
  const fake = fakeRuntime();
  const sandbox = createBashSandbox(fake.runtime, "linux");
  const wrapped = await sandbox.wrap(COMMAND, cwd, { TMPDIR: "/var/probe" });
  assert.equal(wrapped, `sandboxed ${COMMAND}`);
  const [call] = fake.calls;
  assert.ok(call);
  assert.equal(call.command, COMMAND);
  assert.equal(call.binShell, undefined);
  assert.deepEqual(call.customConfig.filesystem?.allowWrite, [
    cwd,
    "/var/probe",
  ]);
  const place = directories(process.env);
  assert.deepEqual(call.customConfig.filesystem?.denyRead, [
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    piAgentDirectory(),
    join(place.state, "workers"),
    join(place.state, "kanthord.log"),
    place.config,
    join(place.data, "kanthord.db"),
    join(place.data, "kanthord.db-wal"),
    join(place.data, "kanthord.db-shm"),
    "~/.config/kanthord-eval",
    "~/.pi/agent",
  ]);
  assert.deepEqual(call.customConfig.filesystem?.denyWrite, [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
  ]);
});

test("the temporary directory falls back to /tmp", async (t) => {
  const cwd = temporary(t);
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap("true", cwd, {});
  assert.deepEqual(fake.calls[0]?.customConfig.filesystem?.allowWrite, [
    cwd,
    "/tmp",
  ]);
});

test("denyRead holds the pi directory and names no ancestor of the cwd", async () => {
  const place = directories(process.env);
  const cwd = join(place.state, "workbench", "swe@1");
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap("true", cwd, {});
  const denied = fake.calls[0]?.customConfig.filesystem?.denyRead ?? [];
  assert.ok(denied.includes(join(place.state, "pi")));
  const ancestors = denied.filter(
    (path) => path === cwd || cwd.startsWith(`${path}/`),
  );
  assert.deepEqual(ancestors, []);
  const initial = fake.initialized[0] as {
    filesystem: { denyRead: string[] };
  };
  assert.deepEqual(
    initial.filesystem.denyRead.filter(
      (path) => path === cwd || cwd.startsWith(`${path}/`),
    ),
    [],
  );
});

test("a rejected initialize makes every wrap reject and never retries", async (t) => {
  const cwd = temporary(t);
  const fake = fakeRuntime({
    initialize: async () => {
      throw new Error("bubblewrap is missing");
    },
  });
  const sandbox = createBashSandbox(fake.runtime, "linux");
  for (let attempt = 0; attempt < TWICE; attempt += ONCE)
    await assert.rejects(
      sandbox.wrap("echo hi", cwd, {}),
      /the bash sandbox is not available: bubblewrap is missing/,
    );
  assert.equal(fake.initialized.length, ONCE);
  assert.deepEqual(fake.calls, []);
  assert.equal(fake.resets(), NO_RESETS);
});

test("a platform other than darwin and linux makes the wrap reject", async (t) => {
  const fake = fakeRuntime();
  const sandbox = createBashSandbox(fake.runtime, "win32");
  await assert.rejects(
    sandbox.wrap("echo hi", temporary(t), {}),
    /the bash sandbox is not available: the platform win32 is unsupported/,
  );
  assert.deepEqual(fake.initialized, []);
  assert.deepEqual(fake.calls, []);
});

test("the runtime starts once for many wraps", async (t) => {
  const cwd = temporary(t);
  const fake = fakeRuntime();
  const sandbox = createBashSandbox(fake.runtime, "darwin");
  await Promise.all([
    sandbox.wrap("a", cwd, {}),
    sandbox.wrap("b", cwd, {}),
    sandbox.wrap("c", cwd, {}),
  ]);
  assert.equal(fake.initialized.length, ONCE);
  assert.equal(fake.calls.length, TWICE + ONCE);
});

test("a sandbox file in the cwd changes nothing", async (t) => {
  const cwd = temporary(t);
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(
    join(cwd, ".pi", "sandbox.json"),
    JSON.stringify({
      enabled: false,
      network: { allowedDomains: ["example.invalid"] },
      filesystem: { denyRead: [], allowWrite: ["/"] },
    }),
  );
  const plain = fakeRuntime();
  const configured = fakeRuntime();
  const other = temporary(t);
  await createBashSandbox(plain.runtime, "linux").wrap("true", other, {});
  await createBashSandbox(configured.runtime, "linux").wrap("true", cwd, {});
  const first = plain.calls[0]?.customConfig;
  const second = configured.calls[0]?.customConfig;
  assert.deepEqual(second?.network, first?.network);
  assert.deepEqual(second?.filesystem?.denyRead, first?.filesystem?.denyRead);
  assert.deepEqual(second?.filesystem?.allowWrite, [cwd, "/tmp"]);
  assert.deepEqual(plain.initialized, configured.initialized);
  assert.equal(
    second?.network?.allowedDomains.includes("example.invalid"),
    false,
  );
});

test("a wrap passes the whole filesystem object and the network allowlist", async (t) => {
  const cwd = temporary(t);
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap("true", cwd, {});
  const [call] = fake.calls;
  assert.ok(call);
  assert.deepEqual(Object.keys(call.customConfig.filesystem ?? {}).sort(), [
    "allowWrite",
    "denyRead",
    "denyWrite",
  ]);
  assert.deepEqual(call.customConfig.network, {
    allowedDomains: [
      "registry.npmjs.org",
      "github.com",
      "ssh.github.com",
      "api.github.com",
      "gitlab.com",
      "altssh.gitlab.com",
      "bitbucket.org",
      "altssh.bitbucket.org",
      "api.bitbucket.org",
    ],
    deniedDomains: [],
    allowLocalBinding: true,
  });
});
