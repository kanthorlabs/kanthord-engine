import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { test, type TestContext } from "node:test";
import { directories } from "../kernel/xdg.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  createBashSandbox,
  hostDenyRead,
  scopedDenyRead,
} from "./bash-sandbox.ts";
import { piAgentDirectory } from "./pi.ts";

const TWICE = 2;
const ONCE = 1;
const COMMAND = "echo hi";
const ABSENT_HOME = "/kanthord-absent-home";

function hostOf(env: NodeJS.ProcessEnv = {}) {
  return {
    env: { HOME: ABSENT_HOME, ...env },
    denyRead: hostDenyRead(process.env),
  };
}

const SANDBOXED_COMMAND = 'eval "$KANTHORD_BASH_COMMAND"';

function exportedCommand(command: string, temporaryDirectory: string): string {
  return `export KANTHORD_BASH_COMMAND='${command}' TMPDIR='${temporaryDirectory}' ${packageCacheExports(temporaryDirectory)}; sandboxed ${SANDBOXED_COMMAND}`;
}

function packageCacheExports(temporaryDirectory: string): string {
  return [
    `pnpm_config_store_dir='${temporaryDirectory}/pnpm-store'`,
    `pnpm_config_cache_dir='${temporaryDirectory}/pnpm-cache'`,
    `npm_config_cache='${temporaryDirectory}/npm-cache'`,
  ].join(" ");
}

function fakeRuntime(options: { initialize?: () => Promise<void> } = {}) {
  const calls: {
    command: string;
    binShell: string | undefined;
    customConfig: {
      filesystem?: {
        allowRead: string[];
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
  assert.equal(wrapped, exportedCommand(COMMAND, "/var/probe"));
  const [call] = fake.calls;
  assert.ok(call);
  assert.equal(call.command, SANDBOXED_COMMAND);
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
    ABSENT_HOME,
  ]);
  assert.deepEqual(call.customConfig.filesystem?.allowRead, [
    cwd,
    "/var/probe",
    join(ABSENT_HOME, ".gitconfig"),
    join(ABSENT_HOME, ".config", "git"),
  ]);
  assert.deepEqual(call.customConfig.filesystem?.denyWrite, [
    join(cwd, ".env"),
    join(cwd, ".env.*"),
    join(cwd, "*.pem"),
    join(cwd, "*.key"),
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

test("hostDenyRead holds the resolved config file of the scope", (t) => {
  const file = join(temporary(t), "serve", "kanthord.yaml");
  assert.ok(hostDenyRead(process.env, { config: file }).includes(file));
});

test("(invariant) without a config scope hostDenyRead keeps the KANTHORD_CONFIG file", (t) => {
  const overridden = join(temporary(t), "kanthord.yaml");
  const env = { ...process.env, KANTHORD_CONFIG: overridden };
  assert.ok(hostDenyRead(env).includes(overridden));
  assert.ok(hostDenyRead(env, {}).includes(overridden));
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
  assert.deepEqual(second?.filesystem?.allowRead, [
    cwd,
    ...(first?.filesystem?.allowRead.slice(1) ?? []),
  ]);
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
    "allowRead",
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
    env: { HOME: ABSENT_HOME, TMPDIR: tmp },
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
    env: { HOME: ABSENT_HOME, TMPDIR: tmp },
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
  const wrapped = await createBashSandbox(fake.runtime, "linux").wrap(
    COMMAND,
    temporary(t),
    hostOf({ TMPDIR: "/var/it's here" }),
  );
  assert.equal(wrapped, exportedCommand(COMMAND, "/var/it'\\''s here"));
});

test("(invariant) the runtime receives the same short command for any agent command", async (t) => {
  const fake = fakeRuntime();
  const sandbox = createBashSandbox(fake.runtime, "linux");
  const long = `echo ${"x".repeat(5000)}`;
  await sandbox.wrap(COMMAND, temporary(t), hostOf());
  await sandbox.wrap(long, temporary(t), hostOf());
  assert.deepEqual(
    fake.calls.map((call) => call.command),
    [SANDBOXED_COMMAND, SANDBOXED_COMMAND],
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

const SECRET_PATHS = [
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".config/gh/hosts.yml",
  ".docker/config.json",
  ".claude/settings.json",
  ".codex/auth.json",
];
const MANY_CHILDREN = 2000;
const FEW_CHILDREN = 2;
const WRAPPED_LIMIT = 64 * 1024;

function homeLayout(t: TestContext) {
  const root = realpathSync(temporary(t));
  const home = join(root, "home");
  const cwd = join(home, "work", "repo");
  const tmp = join(root, "tmp");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(tmp);
  return { root, home, cwd, tmp };
}

function touch(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}

async function allowReadOf(
  host: Parameters<ReturnType<typeof createBashSandbox>["wrap"]>[2],
  cwd: string,
): Promise<string[]> {
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap(COMMAND, cwd, host);
  return fake.calls[0]?.customConfig.filesystem?.allowRead ?? [];
}

test("(invariant guard) the deny list holds the home and the allow list holds no credential path or ancestor of one", async (t) => {
  const { home, cwd, tmp } = homeLayout(t);
  for (const file of SECRET_PATHS) touch(join(home, file));
  const host = {
    env: { HOME: home, TMPDIR: tmp, PATH: "/usr/bin" },
    denyRead: [],
  };
  assert.deepEqual(scopedDenyRead(host, cwd), [home]);
  const allowed = await allowReadOf(host, cwd);
  for (const file of SECRET_PATHS)
    assert.deepEqual(ancestorsOf(allowed, join(home, file)), [], file);
});

test("(invariant guard) the allow list holds the cwd, TMPDIR, the instance root and each tool root and the deny list names none of them", async (t) => {
  const { home, cwd } = homeLayout(t);
  const tmp = join(home, "scratch", "tmp");
  const instance = join(home, "instances", "coder-1");
  const bin = join(home, ".local", "bin");
  const toolchain = join(home, ".nvm", "versions", "v1");
  for (const directory of [tmp, instance, bin, join(toolchain, "bin")])
    mkdirSync(directory, { recursive: true });
  touch(join(toolchain, "bin", "node"));
  chmodSync(join(toolchain, "bin", "node"), 0o755);
  touch(join(home, "instances", "coder-2", "file"));
  const host = {
    env: {
      HOME: home,
      TMPDIR: tmp,
      PATH: [bin, join(toolchain, "bin")].join(":"),
    },
    denyRead: [],
    root: instance,
  };
  const kept = [
    cwd,
    tmp,
    instance,
    bin,
    toolchain,
    join(home, ".gitconfig"),
    join(home, ".config", "git"),
  ];
  const allowed = await allowReadOf(host, cwd);
  const denied = scopedDenyRead(host, cwd);
  for (const path of kept) {
    assert.ok(allowed.includes(path), `${path} in ${allowed}`);
    assert.deepEqual(ancestorsOf(denied, path), [home], path);
  }
  assert.deepEqual(denied, [home]);
});

test("(invariant guard) a PATH entry inside a host deny entry leaves that entry in the list", (t) => {
  const { home, cwd, tmp } = homeLayout(t);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  };
  const place = directories(env);
  const piBin = join(home, ".pi", "agent", "bin");
  const configBin = join(place.config, "bin");
  mkdirSync(piBin, { recursive: true });
  mkdirSync(configBin, { recursive: true });
  const denied = scopedDenyRead(
    {
      env: { ...env, TMPDIR: tmp, PATH: [piBin, configBin].join(":") },
      denyRead: hostDenyRead(env),
    },
    cwd,
  );
  assert.ok(denied.includes("~/.pi/agent"));
  assert.ok(denied.includes(place.config));
});

test("(invariant guard) the allow list holds no PATH entry that lies inside a host deny entry", async (t) => {
  const { home, cwd, tmp } = homeLayout(t);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_DATA_HOME: join(home, ".local", "share"),
  };
  const place = directories(env);
  const piBin = join(home, ".pi", "agent", "bin");
  const configBin = join(place.config, "bin");
  const toolBin = join(home, ".local", "bin");
  for (const directory of [piBin, configBin, toolBin])
    mkdirSync(directory, { recursive: true });
  const allowed = await allowReadOf(
    {
      env: {
        ...env,
        TMPDIR: tmp,
        PATH: [piBin, configBin, toolBin].join(":"),
      },
      denyRead: hostDenyRead(env),
    },
    cwd,
  );
  assert.ok(allowed.includes(toolBin));
  assert.ok(!allowed.includes(piBin));
  assert.ok(!allowed.includes(configBin));
});

test("(edge) a cwd outside the home directory leaves the home denied and the tool roots allowed", async (t) => {
  const { root, home, tmp } = homeLayout(t);
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  touch(join(home, ".local", "bin", "tool"));
  touch(join(home, ".config", "gh", "hosts.yml"));
  const host = {
    env: {
      HOME: home,
      TMPDIR: tmp,
      PATH: ["/usr/bin", join(home, ".local", "bin")].join(":"),
    },
    denyRead: [],
  };
  assert.deepEqual(scopedDenyRead(host, cwd), [home]);
  assert.deepEqual(await allowReadOf(host, cwd), [
    cwd,
    tmp,
    join(home, ".local", "bin"),
    join(home, ".gitconfig"),
    join(home, ".config", "git"),
  ]);
});

test("(edge) a home child created after the first wrap stays denied through the home entry", async (t) => {
  const { home, cwd, tmp } = homeLayout(t);
  const fake = fakeRuntime();
  const sandbox = createBashSandbox(fake.runtime, "linux");
  const host = {
    env: { HOME: home, TMPDIR: tmp, PATH: "/usr/bin" },
    denyRead: [],
  };
  await sandbox.wrap(COMMAND, cwd, host);
  touch(join(home, ".later-credentials"));
  await sandbox.wrap(COMMAND, cwd, host);
  for (const call of fake.calls)
    assert.deepEqual(call.customConfig.filesystem?.denyRead, [home]);
});

test("(regression: K195) the filesystem rules in the wrapped command stay below 64 KiB and keep their size with 2000 home children", async (t) => {
  const { home, cwd, tmp } = homeLayout(t);
  const fake = fakeRuntime();
  fake.runtime.wrapWithSandbox = async (command, _binShell, customConfig) =>
    `sandboxed ${command} ${JSON.stringify(customConfig?.filesystem)}`;
  const sandbox = createBashSandbox(fake.runtime, "linux");
  const host = {
    env: { HOME: home, TMPDIR: tmp, PATH: "/usr/bin" },
    denyRead: [],
  };
  const sizeOf = async (): Promise<number> =>
    (await sandbox.wrap(COMMAND, cwd, host)).length;
  for (let child = 0; child < FEW_CHILDREN; child += ONCE)
    touch(join(home, `child-${child}`));
  const few = await sizeOf();
  for (let child = FEW_CHILDREN; child < MANY_CHILDREN; child += ONCE)
    touch(join(home, `child-${child}`));
  const many = await sizeOf();
  assert.ok(many < WRAPPED_LIMIT, `${many} bytes`);
  assert.equal(many, few);
});

test("(happy) a wrapped command exports TMPDIR and the package store and cache under the temporary directory", async (t) => {
  const tmp = temporary(t);
  const fake = fakeRuntime();
  const wrapped = await createBashSandbox(fake.runtime, "linux").wrap(
    COMMAND,
    temporary(t),
    hostOf({ TMPDIR: tmp }),
  );
  assert.equal(wrapped, exportedCommand(COMMAND, tmp));
});

test("(happy) the denyWrite list of a wrap holds the default patterns under the cwd and no relative entry", async (t) => {
  const cwd = temporary(t);
  const fake = fakeRuntime();
  await createBashSandbox(fake.runtime, "linux").wrap(COMMAND, cwd, hostOf());
  const denyWrite = fake.calls[0]?.customConfig.filesystem?.denyWrite ?? [];
  assert.deepEqual(denyWrite, [
    join(cwd, ".env"),
    join(cwd, ".env.*"),
    join(cwd, "*.pem"),
    join(cwd, "*.key"),
  ]);
  assert.ok(denyWrite.every((entry) => entry.startsWith(sep)));
  const initial = fake.initialized[0] as {
    filesystem: { denyWrite: string[] };
  };
  assert.ok(
    initial.filesystem.denyWrite.every((entry) => entry.startsWith(sep)),
  );
});

test("(edge) a PATH entry inside a node_modules directory is no tool root", async (t) => {
  const { home, cwd, tmp } = homeLayout(t);
  const packages = join(home, "project", "node_modules", ".bin");
  mkdirSync(packages, { recursive: true });
  const allowed = (path: string) =>
    allowReadOf(
      { env: { HOME: home, TMPDIR: tmp, PATH: path }, denyRead: [] },
      cwd,
    );
  assert.deepEqual(
    await allowed(`${packages}:/usr/bin`),
    await allowed("/usr/bin"),
  );
});

test("(edge) a PATH entry inside a directory that the process cannot read adds no error", (t) => {
  const { home, cwd, tmp } = homeLayout(t);
  const closed = join(home, "closed");
  mkdirSync(join(closed, "bin"), { recursive: true });
  chmodSync(closed, 0o000);
  try {
    assert.deepEqual(
      scopedDenyRead(
        {
          env: { HOME: home, TMPDIR: tmp, PATH: join(closed, "bin") },
          denyRead: [],
        },
        cwd,
      ),
      [home],
    );
  } finally {
    chmodSync(closed, 0o755);
  }
});
