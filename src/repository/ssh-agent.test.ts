import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import {
  background,
  CancellationContext,
  cancelled,
  DeadlineExceeded,
} from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import {
  DEADLINE_RADIX,
  SOCKET_PATH_BYTES_MAX,
  SshAgentErrorCode,
  SshAgentStep,
  SSH_AGENT_DIRECTORY_PREFIX,
  SSH_AGENT_SOCKET,
  SWEEP_GRACE_MS,
  sweepSshAgentDirectories,
  withSshAgent,
  type SshKeyAccess,
} from "./ssh-agent.ts";
import { generateSshKey } from "./ssh-key.ts";

const execFileAsync = promisify(execFile);
const DEADLINE_MS = 30_000;
const ELAPSED_DEADLINE_MS = 0;
const AGENT_EXIT_POLL_MS = 20;
const PRIVATE_MODE = 0o700;
const PERMISSION_BITS = 0o777;
const SAMPLES = 5;
const SLOW_AGENT_SECONDS = 6.0137;
const FAILED_AGENT_MS_MAX = 2000;
const SCRIPT_MODE = 0o700;
const SLOW_AGENT_START_MS = 15_000;
const CANCELLED_CODE = "system.context.cancelled";
const LIFECYCLE_RUNS = 3;
const PARALLEL_RUNS = 8;
const SAMPLE_INTERVAL_MS = 20;
const NO_IDENTITY_EXIT = 1;
const NO_AGENT_EXIT = 2;
const PRIVATE_KEY_MARK = "PRIVATE KEY";
const LINE_END = "\n";
const SSH_VARIANT = "ssh";
const DIRECTORY_FILES = ["a", "id.pub", "known_hosts"];
const PORT = 2222;
const KNOWN_HOSTS = `[127.0.0.1]:${PORT} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA\n`;
const PROC = "/proc";
const LINUX = "linux";
const AGENT_PATTERN = /IdentityAgent='([^']+)'/;
const MODULE_URLS = {
  agent: new URL("./ssh-agent.ts", import.meta.url).href,
  key: new URL("./ssh-key.ts", import.meta.url).href,
  context: new URL("../kernel/context.ts", import.meta.url).href,
};

delete process.env.SSH_AUTH_SOCK;
delete process.env.SSH_AGENT_PID;
const scratch = mkdtempSync(join(tmpdir(), "kdt-"));
process.env.TMPDIR = scratch;
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

function access(name: string): SshKeyAccess {
  return { ...generateSshKey(name), known_hosts: KNOWN_HOSTS, port: PORT };
}

function bodyLines(privateKey: string): string[] {
  return privateKey.trim().split(LINE_END).slice(1, -1);
}

function socketOf(env: NodeJS.ProcessEnv): string {
  const match = AGENT_PATTERN.exec(env.GIT_SSH_COMMAND ?? "");
  assert.ok(match?.[1]);
  return match[1];
}

function directoryOf(socket: string): string {
  assert.equal(basename(socket), SSH_AGENT_SOCKET);
  return socket.slice(0, -SSH_AGENT_SOCKET.length - 1);
}

async function commandLines(): Promise<string[]> {
  if (process.platform !== LINUX) {
    const { stdout } = await execFileAsync("ps", ["-axo", "command"]);
    return stdout.split(LINE_END);
  }
  const lines: string[] = [];
  for (const entry of await readdir(PROC)) {
    if (!/^\d+$/.test(entry)) continue;
    const text = await readFile(join(PROC, entry, "cmdline"), "utf8").catch(
      () => "",
    );
    lines.push(text.replaceAll("\0", " "));
  }
  return lines;
}

async function agentLives(socket: string): Promise<boolean> {
  return (await commandLines()).some(
    (line) => line.includes("ssh-agent") && line.includes(socket),
  );
}

async function agentEnds(socket: string, signal: AbortSignal): Promise<void> {
  while (await agentLives(socket))
    await delay(AGENT_EXIT_POLL_MS, undefined, { signal });
}

async function slowAgentLives(): Promise<boolean> {
  return (await commandLines()).some(
    (line) => line.trim() === `sleep ${SLOW_AGENT_SECONDS}`,
  );
}

async function cancelOnSlowAgent(
  context: CancellationContext,
  signal: AbortSignal,
): Promise<number | undefined> {
  const deadlineAt = Date.now() + SLOW_AGENT_START_MS;
  let seen = await slowAgentLives();
  while (!seen && Date.now() < deadlineAt) {
    await delay(AGENT_EXIT_POLL_MS, undefined, { signal });
    seen = await slowAgentLives();
  }
  context.cancel();
  return seen ? Date.now() : undefined;
}

async function identityExit(socket: string): Promise<number> {
  try {
    await execFileAsync("ssh-add", ["-l"], {
      env: { PATH: process.env.PATH, SSH_AUTH_SOCK: socket },
    });
    return 0;
  } catch (error) {
    return (error as { code: number }).code;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null)) !== null;
}

async function assertNoKeyOnDisk(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    if (!(await stat(path)).isFile()) continue;
    assert.equal(
      (await readFile(path, "utf8")).includes(PRIVATE_KEY_MARK),
      false,
    );
  }
}

async function assertNoKeyInArguments(privateKey: string): Promise<void> {
  const lines = await commandLines();
  for (const body of bodyLines(privateKey))
    assert.equal(
      lines.some((line) => line.includes(body)),
      false,
    );
}

function deadlineOf(directory: string): number {
  const encoded = basename(directory)
    .slice(SSH_AGENT_DIRECTORY_PREFIX.length)
    .split("-")[0];
  assert.ok(encoded);
  return Number.parseInt(encoded, DEADLINE_RADIX);
}

test("withSshAgent prepares a private directory and an isolated SSH command", async () => {
  const key = access("layout");
  const fingerprint = key.public_key.split(" ")[1];
  assert.ok(fingerprint);
  await withSshAgent(key, background, DEADLINE_MS, async (env) => {
    const socket = socketOf(env);
    const directory = directoryOf(socket);
    assert.equal((await stat(directory)).mode & PERMISSION_BITS, PRIVATE_MODE);
    assert.deepEqual((await readdir(directory)).sort(), DIRECTORY_FILES);
    assert.equal(
      await readFile(join(directory, "id.pub"), "utf8"),
      key.public_key,
    );
    assert.equal(
      await readFile(join(directory, "known_hosts"), "utf8"),
      KNOWN_HOSTS,
    );
    const { stdout } = await execFileAsync("ssh-add", ["-L"], {
      env: { PATH: process.env.PATH, SSH_AUTH_SOCK: socket },
    });
    assert.equal(stdout.trim(), key.public_key);
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      await assertNoKeyOnDisk(directory);
      await assertNoKeyInArguments(key.private_key);
      await delay(SAMPLE_INTERVAL_MS);
    }
    assert.equal(env.GIT_SSH_VARIANT, SSH_VARIANT);
    assert.equal(
      env.GIT_SSH_COMMAND,
      `ssh -F none -o Port=${PORT} -o IdentitiesOnly=yes -o IdentityFile='${directory}/id.pub' -o IdentityAgent='${directory}/a' -o UserKnownHostsFile='${directory}/known_hosts' -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o BatchMode=yes -o ForwardAgent=no -o ControlMaster=no -o ControlPath=none -o PreferredAuthentications=publickey`,
    );
  });
});

test("withSshAgent ends the agent after a success, a failure and a cancel", async () => {
  const sockets: string[] = [];
  await withSshAgent(
    access("success"),
    background,
    DEADLINE_MS,
    async (env) => {
      sockets.push(socketOf(env));
    },
  );
  await assert.rejects(
    withSshAgent(access("failure"), background, DEADLINE_MS, async (env) => {
      sockets.push(socketOf(env));
      throw new Error("work failed");
    }),
    /work failed/,
  );
  const context = new CancellationContext();
  await assert.rejects(
    withSshAgent(access("cancel"), context, DEADLINE_MS, async (env) => {
      sockets.push(socketOf(env));
      setImmediate(() => context.cancel());
      await cancelled(context.signal);
      throw context.signal.reason;
    }),
  );
  assert.equal(sockets.length, LIFECYCLE_RUNS);
  for (const socket of sockets) {
    assert.ok(
      [NO_IDENTITY_EXIT, NO_AGENT_EXIT].includes(await identityExit(socket)),
    );
    assert.equal(await exists(directoryOf(socket)), false);
  }
  for (const socket of sockets) assert.equal(await agentLives(socket), false);
});

test("parallel withSshAgent calls each load their own key", async () => {
  const keys = Array.from({ length: PARALLEL_RUNS }, (_, index) =>
    access(`parallel-${index}`),
  );
  const loaded = await Promise.all(
    keys.map((key) =>
      withSshAgent(key, background, DEADLINE_MS, async (env) => {
        const { stdout } = await execFileAsync("ssh-add", ["-L"], {
          env: { PATH: process.env.PATH, SSH_AUTH_SOCK: socketOf(env) },
        });
        return stdout.trim();
      }),
    ),
  );
  assert.deepEqual(
    loaded,
    keys.map((key) => key.public_key),
  );
});

async function withSlowAgent(work: (path: string) => Promise<void>) {
  const { stdout } = await execFileAsync("sh", ["-c", "command -v ssh-agent"]);
  await withAgentScript(
    `#!/bin/sh\nsleep ${SLOW_AGENT_SECONDS}\nexec '${stdout.trim()}' "$@"\n`,
    work,
  );
}

async function withAgentScript(
  body: string,
  work: (path: string) => Promise<void>,
) {
  const bin = mkdtempSync(join(scratch, "bin-"));
  const script = join(bin, "ssh-agent");
  writeFileSync(script, body);
  chmodSync(script, SCRIPT_MODE);
  const path = process.env.PATH ?? "";
  process.env.PATH = `${bin}${delimiter}${path}`;
  try {
    await work(path);
  } finally {
    process.env.PATH = path;
  }
}

test("withSshAgent waits for an agent socket that appears after 5 s", async () => {
  await withSlowAgent(async (path) => {
    const key = access("slow");
    const loaded = await withSshAgent(
      key,
      background,
      DEADLINE_MS,
      async (env) => {
        const { stdout: listed } = await execFileAsync("ssh-add", ["-L"], {
          env: { PATH: path, SSH_AUTH_SOCK: socketOf(env) },
        });
        return listed.trim();
      },
    );
    assert.equal(loaded, key.public_key);
  });
});

test("a cancel ends the wait for a slow agent socket and leaves no agent directory", async (t) => {
  await withSlowAgent(async () => {
    const context = new CancellationContext();
    const cancelled = cancelOnSlowAgent(context, t.signal);
    await assert.rejects(
      withSshAgent(access("cancel-wait"), context, DEADLINE_MS, async () => {
        assert.fail("The work must not run.");
      }),
      { code: CANCELLED_CODE },
    );
    const cancelledAt = await cancelled;
    assert.ok(cancelledAt !== undefined);
    assert.equal(await slowAgentLives(), false);
    assert.deepEqual(
      (await readdir(scratch)).filter((name) =>
        name.startsWith(SSH_AGENT_DIRECTORY_PREFIX),
      ),
      [],
    );
  });
});

test("an agent that exits before its socket appears fails the wait at once", async () => {
  const exited = join(scratch, "agent-exited");
  await withAgentScript(
    `#!/bin/sh\necho 'bind: No such file or directory' >&2\ntouch '${exited}'\nexit 1\n`,
    async () => {
      await assert.rejects(
        withSshAgent(access("failed"), background, DEADLINE_MS, async () => {
          assert.fail("The work must not run.");
        }),
        (error: unknown) => {
          assert.ok(error instanceof Diagnostic);
          assert.equal(error.code, SshAgentErrorCode.Failed);
          assert.deepEqual(error.fields, [["step", SshAgentStep.Agent]]);
          return true;
        },
      );
      assert.ok(Date.now() - statSync(exited).mtimeMs < FAILED_AGENT_MS_MAX);
      rmSync(exited);
    },
  );
});

test("withSshAgent refuses a socket path above the limit", async () => {
  const long = join(scratch, "l".repeat(SOCKET_PATH_BYTES_MAX));
  mkdirSync(long);
  process.env.TMPDIR = long;
  try {
    await assert.rejects(
      withSshAgent(access("long"), background, DEADLINE_MS, async () => {
        assert.fail("work must not run");
      }),
      (error: unknown) => {
        assert.ok(error instanceof Diagnostic);
        assert.equal(error.code, SshAgentErrorCode.Failed);
        assert.deepEqual(error.fields, [["step", SshAgentStep.SocketPath]]);
        return true;
      },
    );
    assert.deepEqual(await readdir(long), []);
  } finally {
    process.env.TMPDIR = scratch;
  }
});

for (const [label, name] of [
  ["whitespace", "with space"],
  ["a percent token", "with%d"],
] as const)
  test(`withSshAgent refuses a directory path with ${label}`, async () => {
    const unsafe = join(scratch, name);
    mkdirSync(unsafe);
    process.env.TMPDIR = unsafe;
    try {
      await assert.rejects(
        withSshAgent(access("unsafe"), background, DEADLINE_MS, async () => {
          assert.fail("work must not run");
        }),
        (error: unknown) => {
          assert.ok(error instanceof Diagnostic);
          assert.equal(error.code, SshAgentErrorCode.Failed);
          assert.deepEqual(error.fields, [["step", SshAgentStep.SocketPath]]);
          return true;
        },
      );
      assert.deepEqual(await readdir(unsafe), []);
    } finally {
      process.env.TMPDIR = scratch;
    }
  });

test("withSshAgent reports an ssh-add refusal with no key material", async () => {
  const key = access("refused");
  const lines = key.private_key.trim().split(LINE_END);
  const broken = [...lines.slice(0, 2), lines.at(-1)].join(LINE_END);
  const before = await readdir(scratch);
  await assert.rejects(
    withSshAgent(
      { ...key, private_key: broken },
      background,
      DEADLINE_MS,
      async () => assert.fail("work must not run"),
    ),
    (error: unknown) => {
      assert.ok(error instanceof Diagnostic);
      assert.equal(error.code, SshAgentErrorCode.Failed);
      assert.deepEqual(error.fields, [["step", SshAgentStep.Load]]);
      const cause = String((error.cause as Error).message);
      for (const body of bodyLines(key.private_key))
        assert.equal(cause.includes(body), false);
      return true;
    },
  );
  assert.deepEqual(await readdir(scratch), before);
});

test("withSshAgent throws DeadlineExceeded for an elapsed deadline before it starts an agent", async () => {
  const started = join(scratch, "agent-started");
  await withAgentScript(`#!/bin/sh\ntouch '${started}'\nexit 1\n`, async () => {
    await assert.rejects(
      withSshAgent(
        access("elapsed"),
        background,
        ELAPSED_DEADLINE_MS,
        async () => assert.fail("The work must not run."),
      ),
      DeadlineExceeded,
    );
    assert.throws(() => statSync(started), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(scratch)).filter((name) =>
        name.startsWith(SSH_AGENT_DIRECTORY_PREFIX),
      ),
      [],
    );
  });
});

test("a killed process leaves no agent, and a later sweep removes its directory", async (t) => {
  const script = `
    const { withSshAgent } = await import(${JSON.stringify(MODULE_URLS.agent)});
    const { generateSshKey } = await import(${JSON.stringify(MODULE_URLS.key)});
    const { background } = await import(${JSON.stringify(MODULE_URLS.context)});
    setInterval(() => {}, 1000);
    await withSshAgent({ ...generateSshKey("crash"), known_hosts: "", port: 22 }, background, 60000, async (env) => {
      process.stdout.write(env.GIT_SSH_COMMAND + "\\n");
      await new Promise(() => {});
    });
  `;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      env: { PATH: process.env.PATH, TMPDIR: scratch },
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  const command = await new Promise<string>((resolve) => {
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes(LINE_END)) resolve(text);
    });
  });
  const socket = socketOf({ GIT_SSH_COMMAND: command });
  assert.equal(await agentLives(socket), true);
  child.kill("SIGKILL");
  await closed;
  await agentEnds(socket, t.signal);
  const directory = directoryOf(socket);
  assert.equal(await exists(directory), true);
  await sweepSshAgentDirectories(deadlineOf(directory) + SWEEP_GRACE_MS + 1);
  assert.equal(await exists(directory), false);
});

test("a terminated worker thread leaves no agent", async (t) => {
  const script = `
    const { parentPort } = require("node:worker_threads");
    (async () => {
      const { withSshAgent } = await import(${JSON.stringify(MODULE_URLS.agent)});
      const { generateSshKey } = await import(${JSON.stringify(MODULE_URLS.key)});
      const { background } = await import(${JSON.stringify(MODULE_URLS.context)});
      await withSshAgent({ ...generateSshKey("thread"), known_hosts: "", port: 22 }, background, 60000, async (env) => {
        parentPort.postMessage(env.GIT_SSH_COMMAND);
        await new Promise(() => {});
      });
    })();
  `;
  const worker = new Worker(script, { eval: true });
  const command = await new Promise<string>((resolve) =>
    worker.once("message", resolve),
  );
  const socket = socketOf({ GIT_SSH_COMMAND: command });
  assert.equal(await agentLives(socket), true);
  await worker.terminate();
  await agentEnds(socket, t.signal);
  const directory = directoryOf(socket);
  await sweepSshAgentDirectories(deadlineOf(directory) + SWEEP_GRACE_MS + 1);
  assert.equal(await exists(directory), false);
});

test("the sweep spares a directory whose deadline is not past", async () => {
  const now = Date.now();
  const named = (deadlineAt: number, suffix: string) =>
    join(
      scratch,
      `${SSH_AGENT_DIRECTORY_PREFIX}${deadlineAt.toString(DEADLINE_RADIX)}-${suffix}`,
    );
  const live = named(now + DEADLINE_MS, "live");
  const recent = named(now - SWEEP_GRACE_MS / 2, "recent");
  const expired = named(now - SWEEP_GRACE_MS - DEADLINE_MS, "expired");
  const foreign = join(scratch, "kd-other-1-expired");
  for (const path of [live, recent, expired, foreign]) await mkdir(path);
  await sweepSshAgentDirectories(now);
  assert.equal(await exists(live), true);
  assert.equal(await exists(recent), true);
  assert.equal(await exists(foreign), true);
  assert.equal(await exists(expired), false);
});

test("the sweep keeps an expired directory whose agent socket accepts a connection", async (t) => {
  const deadlineAt = Date.now() - SWEEP_GRACE_MS - DEADLINE_MS;
  const named = (suffix: string) =>
    join(
      scratch,
      `${SSH_AGENT_DIRECTORY_PREFIX}${deadlineAt.toString(DEADLINE_RADIX)}-${suffix}`,
    );
  const live = named("live");
  const dead = named("dead");
  for (const path of [live, dead]) await mkdir(path);
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve) =>
    server.listen(join(live, SSH_AGENT_SOCKET), resolve),
  );
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await sweepSshAgentDirectories(Date.now());
  assert.equal(await exists(live), true);
  assert.equal(await exists(dead), false);
});
