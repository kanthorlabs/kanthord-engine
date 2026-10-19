import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import { background, CancellationContext } from "../kernel/context.ts";
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
  type SshAccess,
} from "./ssh-agent.ts";
import { generateSshKey } from "./ssh-key.ts";

const execFileAsync = promisify(execFile);
const DEADLINE_MS = 30_000;
const AGENT_EXIT_WAIT_MS = 11_000;
const PRIVATE_MODE = 0o700;
const PERMISSION_BITS = 0o777;
const SAMPLES = 5;
const LIFECYCLE_RUNS = 3;
const SAMPLE_INTERVAL_MS = 20;
const NO_IDENTITY_EXIT = 1;
const NO_AGENT_EXIT = 2;
const PRIVATE_KEY_MARK = "PRIVATE KEY";
const LINE_END = "\n";
const SSH_VARIANT = "ssh";
const DIRECTORY_FILES = ["a", "id.pub", "known_hosts"];
const KNOWN_HOSTS = "[127.0.0.1]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA\n";
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

function access(name: string): SshAccess {
  return { ...generateSshKey(name), known_hosts: KNOWN_HOSTS };
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
      `ssh -F none -o IdentitiesOnly=yes -o IdentityFile='${directory}/id.pub' -o IdentityAgent='${directory}/a' -o UserKnownHostsFile='${directory}/known_hosts' -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o BatchMode=yes -o ForwardAgent=no -o ControlMaster=no -o ControlPath=none -o PreferredAuthentications=publickey`,
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
      await context.done();
      throw context.err();
    }),
  );
  assert.equal(sockets.length, LIFECYCLE_RUNS);
  for (const socket of sockets) {
    assert.ok(
      [NO_IDENTITY_EXIT, NO_AGENT_EXIT].includes(await identityExit(socket)),
    );
    assert.equal(await exists(directoryOf(socket)), false);
  }
  await delay(AGENT_EXIT_WAIT_MS);
  for (const socket of sockets) assert.equal(await agentLives(socket), false);
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

test("a killed process leaves no agent, and a later sweep removes its directory", async () => {
  const script = `
    const { withSshAgent } = await import(${JSON.stringify(MODULE_URLS.agent)});
    const { generateSshKey } = await import(${JSON.stringify(MODULE_URLS.key)});
    const { background } = await import(${JSON.stringify(MODULE_URLS.context)});
    setInterval(() => {}, 1000);
    await withSshAgent({ ...generateSshKey("crash"), known_hosts: "" }, background, 60000, async (env) => {
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
  await delay(AGENT_EXIT_WAIT_MS);
  assert.equal(await agentLives(socket), false);
  const directory = directoryOf(socket);
  assert.equal(await exists(directory), true);
  await sweepSshAgentDirectories(deadlineOf(directory) + SWEEP_GRACE_MS + 1);
  assert.equal(await exists(directory), false);
});

test("a terminated worker thread leaves no agent", async () => {
  const script = `
    const { parentPort } = require("node:worker_threads");
    (async () => {
      const { withSshAgent } = await import(${JSON.stringify(MODULE_URLS.agent)});
      const { generateSshKey } = await import(${JSON.stringify(MODULE_URLS.key)});
      const { background } = await import(${JSON.stringify(MODULE_URLS.context)});
      await withSshAgent({ ...generateSshKey("thread"), known_hosts: "" }, background, 60000, async (env) => {
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
  await delay(AGENT_EXIT_WAIT_MS);
  assert.equal(await agentLives(socket), false);
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
