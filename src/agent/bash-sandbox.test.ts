import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { directories } from "../kernel/xdg.ts";
import { temporary } from "../kernel/test-support.ts";
import { createBashSandbox, hostDenyRead } from "./bash-sandbox.ts";
import { piAgentDirectory } from "./pi.ts";

const TWICE = 2;
const ONCE = 1;
const COMMAND = "echo hi";

function hostOf(env: NodeJS.ProcessEnv = {}) {
  return { env, denyRead: hostDenyRead(process.env) };
}

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
  const resets: boolean[] = [];
  return {
    calls,
    initialized,
    resets,
    runtime: {
      initialize: async (config: unknown) => {
        initialized.push(config);
        await options.initialize?.();
      },
      reset: async () => {
        resets.push(true);
      },
      wrapWithSandbox: async (
        command: string,
        binShell?: string,
        customConfig: (typeof calls)[number]["customConfig"] = {},
      ) => {
        calls.push({ command, binShell, customConfig });
        return `sandboxed ${command}`;
      },
    },
  };
}

test("a wrap passes the cwd and the temporary directory as allowWrite and the denyRead list", async (t) => {
  const cwd = temporary(t);
  const fake = fakeRuntime();
  const sandbox = createBashSandbox(fake.runtime, "linux");
  const wrapped = await sandbox.wrap(
    COMMAND,
    cwd,
    hostOf({ TMPDIR: "/var/probe" }),
  );
  const exported = `export TMPDIR='/var/probe'; ${COMMAND}`;
  assert.equal(wrapped, `sandboxed ${exported}`);
  const [call] = fake.calls;
  assert.ok(call);
  assert.equal(call.command, exported);
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
    ...(process.env.KANTHORD_CONFIG ? [process.env.KANTHORD_CONFIG] : []),
    place.data,
    join(place.data, "kanthord.db"),
    join(place.data, "kanthord.db-wal"),
    join(place.data, "kanthord.db-shm"),
    join(place.state, "projects"),
    join(place.state, "environments"),
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

test("(security) denyRead holds a config file that KANTHORD_CONFIG names outside the config directory", async (t) => {
  const cwd = temporary(t);
  const overridden = join(temporary(t), "kanthord.yaml");
  const previous = process.env.KANTHORD_CONFIG;
  process.env.KANTHORD_CONFIG = overridden;
  t.after(() => {
    if (previous === undefined) delete process.env.KANTHORD_CONFIG;
    else process.env.KANTHORD_CONFIG = previous;
  });
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap(COMMAND, cwd, hostOf());
  assert.ok(
    fake.calls[0]?.customConfig.filesystem?.denyRead.includes(overridden),
  );
});

test("an empty KANTHORD_CONFIG adds no denyRead entry", async (t) => {
  const cwd = temporary(t);
  const previous = process.env.KANTHORD_CONFIG;
  process.env.KANTHORD_CONFIG = "";
  t.after(() => {
    if (previous === undefined) delete process.env.KANTHORD_CONFIG;
    else process.env.KANTHORD_CONFIG = previous;
  });
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap(COMMAND, cwd, hostOf());
  assert.ok(
    !fake.calls[0]?.customConfig.filesystem?.denyRead.includes(process.cwd()),
  );
});

test("the temporary directory falls back to /tmp", async (t) => {
  const cwd = temporary(t);
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap("true", cwd, hostOf());
  assert.deepEqual(fake.calls[0]?.customConfig.filesystem?.allowWrite, [
    cwd,
    "/tmp",
  ]);
});

test("denyRead holds the pi directory and names no ancestor of the cwd", async () => {
  const place = directories(process.env);
  const cwd = join(place.state, "workbench", "swe@1");
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap("true", cwd, hostOf());
  const denied = fake.calls[0]?.customConfig.filesystem?.denyRead ?? [];
  assert.ok(denied.includes(join(place.state, "pi")));
  for (const path of [
    place.data,
    join(place.state, "projects"),
    join(place.state, "environments"),
  ])
    assert.ok(denied.includes(path));
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
      sandbox.wrap("echo hi", cwd, hostOf()),
      /the bash sandbox is not available: bubblewrap is missing/,
    );
  assert.equal(fake.initialized.length, ONCE);
  assert.deepEqual(fake.calls, []);
});

test("a platform other than darwin and linux makes the wrap reject", async (t) => {
  const fake = fakeRuntime();
  const sandbox = createBashSandbox(fake.runtime, "win32");
  await assert.rejects(
    sandbox.wrap("echo hi", temporary(t), hostOf()),
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
    sandbox.wrap("a", cwd, hostOf()),
    sandbox.wrap("b", cwd, hostOf()),
    sandbox.wrap("c", cwd, hostOf()),
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
  await createBashSandbox(plain.runtime, "linux").wrap("true", other, hostOf());
  await createBashSandbox(configured.runtime, "linux").wrap(
    "true",
    cwd,
    hostOf(),
  );
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
  await createBashSandbox(fake.runtime, "linux").wrap("true", cwd, hostOf());
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
      "objects.githubusercontent.com",
      "release-assets.githubusercontent.com",
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
  });
});

function instanceLayout(t: TestContext) {
  const home = temporary(t);
  const env: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  };
  const place = directories(env);
  const instance = join(place.data, "workers", "coder-1");
  const workspace = join(instance, "workspaces", "node", "checkouts", "engine");
  const tmp = join(instance, "tmp");
  for (const directory of [
    workspace,
    tmp,
    join(place.data, "workers", "coder-2"),
  ])
    mkdirSync(directory, { recursive: true });
  for (const file of [
    "tracking.db",
    "tracking.db-wal",
    "tracking.db-shm",
    "kanthord.db.bak-1",
    "tracking.db.bak-1",
  ])
    writeFileSync(join(place.data, file), "");
  return { env, place, instance, workspace, tmp };
}

function ancestorsOf(list: readonly string[], path: string): string[] {
  return list.filter(
    (denied) => path === denied || path.startsWith(`${denied}/`),
  );
}

test("(security) with a worker environment denyRead holds the credential paths, the siblings of the instance root and names no ancestor of a workspace or of TMPDIR", async (t) => {
  const { env, place, instance, workspace, tmp } = instanceLayout(t);
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap(COMMAND, workspace, {
    env: { TMPDIR: tmp },
    denyRead: hostDenyRead(env, { pi: join(instance, "pi") }),
    root: instance,
  });
  const denied = fake.calls[0]?.customConfig.filesystem?.denyRead ?? [];
  for (const path of [
    "~/.config/kanthord-eval",
    "~/.pi/agent",
    place.config,
    join(instance, "pi"),
    join(place.data, "kanthord.db"),
    join(place.data, "tracking.db"),
    join(place.data, "tracking.db-wal"),
    join(place.data, "tracking.db-shm"),
    join(place.data, "kanthord.db.bak-1"),
    join(place.data, "tracking.db.bak-1"),
    join(place.data, "workers", "coder-2"),
  ])
    assert.ok(denied.includes(path), path);
  assert.ok(!denied.includes(place.data));
  assert.ok(!denied.includes(instance));
  for (const path of [workspace, tmp])
    assert.deepEqual(ancestorsOf(denied, path), []);
});

test("(security) an instance root created after the first wrap is denied on the next wrap", async (t) => {
  const { env, place, instance, workspace, tmp } = instanceLayout(t);
  const fake = fakeRuntime();
  const sandbox = createBashSandbox(fake.runtime, "linux");
  const host = {
    env: { TMPDIR: tmp },
    denyRead: hostDenyRead(env, { pi: join(instance, "pi") }),
    root: instance,
  };
  await sandbox.wrap(COMMAND, workspace, host);
  const later = join(place.data, "workers", "coder-3");
  assert.ok(!fake.calls[0]?.customConfig.filesystem?.denyRead.includes(later));
  mkdirSync(later);
  await sandbox.wrap(COMMAND, workspace, host);
  assert.ok(fake.calls[1]?.customConfig.filesystem?.denyRead.includes(later));
});

test("(security) denyRead holds an absolute EVAL_ANTHROPIC_AUTH_FILE and its link target", async (t) => {
  const directory = temporary(t);
  const target = join(directory, "auth.json");
  const link = join(directory, "linked.json");
  writeFileSync(target, "");
  symlinkSync(target, link);
  const denied = hostDenyRead({ EVAL_ANTHROPIC_AUTH_FILE: link });
  assert.ok(denied.includes(link));
  assert.ok(denied.includes(realpathSync(target)));
});

test("a relative EVAL_ANTHROPIC_AUTH_FILE adds no denyRead entry", () => {
  assert.deepEqual(
    hostDenyRead({ EVAL_ANTHROPIC_AUTH_FILE: "auth.json" }),
    hostDenyRead({}),
  );
});

test("(security) denyWrite holds the config and the hooks of each .git directory under the cwd", async (t) => {
  const cwd = temporary(t);
  const own = join(cwd, ".git");
  const checkout = join(cwd, "checkouts", "engine", ".git");
  const third = join(cwd, "a", "b", "c", ".git");
  const deep = join(cwd, "a", "b", "c", "d", ".git");
  for (const directory of [own, checkout, third, deep])
    mkdirSync(directory, { recursive: true });
  mkdirSync(join(cwd, "linked"));
  writeFileSync(join(cwd, "linked", ".git"), "gitdir: /elsewhere\n");
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap(COMMAND, cwd, hostOf());
  const denyWrite = fake.calls[0]?.customConfig.filesystem?.denyWrite ?? [];
  for (const git of [own, checkout, third]) {
    assert.ok(denyWrite.includes(join(git, "config")));
    assert.ok(denyWrite.includes(join(git, "hooks")));
  }
  assert.ok(!denyWrite.includes(join(deep, "config")));
  assert.ok(!denyWrite.includes(join(cwd, "linked", ".git", "config")));
});

test("a wrap exports the TMPDIR of the host before the command", async (t) => {
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap(
    COMMAND,
    temporary(t),
    hostOf({ TMPDIR: "/var/it's here" }),
  );
  assert.equal(
    fake.calls[0]?.command,
    `export TMPDIR='/var/it'\\''s here'; ${COMMAND}`,
  );
});

test("dispose resets the runtime and the next wrap initializes it again", async (t) => {
  const cwd = temporary(t);
  const fake = fakeRuntime();
  const sandbox = createBashSandbox(fake.runtime, "linux");
  await sandbox.wrap(COMMAND, cwd, hostOf());
  await sandbox.dispose();
  assert.equal(fake.resets.length, ONCE);
  await sandbox.wrap(COMMAND, cwd, hostOf());
  assert.equal(fake.initialized.length, TWICE);
});
