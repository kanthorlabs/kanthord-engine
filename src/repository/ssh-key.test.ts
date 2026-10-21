import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { temporary } from "../kernel/test-support.ts";
import { generateSshKey, sshFingerprintOf, sshPublicKeyOf } from "./ssh-key.ts";

const execFileAsync = promisify(execFile);
const FINGERPRINT_FIELD = 1;
const SOCKET_POLL_MS = 10;
const TRUNCATED_LINES = 2;
const EXIT_SUCCESS = 0;
const LINE_END = "\n";
const FIELD_SEPARATOR = " ";
const SEED_CHECK_PUBLIC_KEY_BYTES = 32;
const SEED_CHECK_LINE_LENGTH = 70;
const NOT_FOUND_INDEX = -1;
const PUBLIC_KEY_PATTERN = /^ssh-ed25519 [A-Za-z0-9+/]+=* kanthord-alpha$/;
const FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;
const ARMOR_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";

delete process.env.SSH_AUTH_SOCK;
delete process.env.SSH_AGENT_PID;

interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function toolEnvironment(socket?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    ...(socket === undefined ? {} : { SSH_AUTH_SOCK: socket }),
  };
}

function runWithInput(
  command: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<ToolResult> {
  const child = spawn(command, args, { env });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(input);
  return new Promise((resolve) =>
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    ),
  );
}

async function scratchAgent(t: TestContext): Promise<string> {
  const socket = join(temporary(t), "a");
  const agent = spawn("ssh-agent", ["-D", "-a", socket], {
    env: toolEnvironment(),
    stdio: "ignore",
  });
  let exited = false;
  const closed = new Promise((resolve) =>
    agent.once("close", () => {
      exited = true;
      resolve(undefined);
    }),
  );
  t.after(async () => {
    agent.kill();
    await closed;
  });
  while (!exited) {
    if (await stat(socket).catch(() => null)) return socket;
    await delay(SOCKET_POLL_MS, undefined, { signal: t.signal });
  }
  assert.fail("The scratch agent did not start.");
}

async function keygenText(t: TestContext, args: string[]): Promise<string> {
  const path = join(temporary(t), "key");
  await execFileAsync("ssh-keygen", ["-q", ...args, "-C", "", "-f", path], {
    env: toolEnvironment(),
  });
  return readFile(path, "utf8");
}

test("generateSshKey derives the fingerprint of ssh-keygen", async () => {
  const key = generateSshKey("alpha");
  assert.match(key.public_key, PUBLIC_KEY_PATTERN);
  assert.match(key.fingerprint, FINGERPRINT_PATTERN);
  assert.ok(key.private_key.startsWith(`${ARMOR_BEGIN}${LINE_END}`));
  assert.equal(sshFingerprintOf(key.public_key), key.fingerprint);
  const result = await runWithInput(
    "ssh-keygen",
    ["-l", "-f", "-"],
    key.public_key,
    toolEnvironment(),
  );
  assert.equal(result.code, EXIT_SUCCESS, result.stderr);
  assert.equal(
    result.stdout.split(FIELD_SEPARATOR)[FINGERPRINT_FIELD],
    key.fingerprint,
  );
});

test("ssh-add loads the generated key from stdin", async (t) => {
  const socket = await scratchAgent(t);
  const key = generateSshKey("alpha");
  const added = await runWithInput(
    "ssh-add",
    ["-q", "-"],
    key.private_key,
    toolEnvironment(socket),
  );
  assert.equal(added.code, EXIT_SUCCESS, added.stderr);
  const { stdout } = await execFileAsync("ssh-add", ["-L"], {
    env: toolEnvironment(socket),
  });
  assert.equal(stdout.trim(), key.public_key);
});

test("sshPublicKeyOf derives the public key of a generated key", () => {
  const key = generateSshKey("alpha");
  assert.equal(sshPublicKeyOf(key.private_key), key.public_key);
});

test("sshPublicKeyOf refuses a PKCS8 text", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const text = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  assert.throws(() => sshPublicKeyOf(text));
});

test("sshPublicKeyOf refuses an encrypted key", async (t) => {
  const text = await keygenText(t, ["-t", "ed25519", "-N", "passphrase"]);
  assert.throws(() => sshPublicKeyOf(text), /encrypted/);
});

test("sshPublicKeyOf refuses an RSA key", async (t) => {
  const text = await keygenText(t, ["-t", "rsa", "-b", "2048", "-N", ""]);
  assert.throws(() => sshPublicKeyOf(text), /ed25519/);
});

test("sshPublicKeyOf refuses a truncated text", () => {
  const lines = generateSshKey("alpha").private_key.trim().split(LINE_END);
  const truncated = [...lines.slice(0, -TRUNCATED_LINES), lines.at(-1)].join(
    LINE_END,
  );
  assert.throws(() => sshPublicKeyOf(truncated));
});

test("sshFingerprintOf refuses a key of another type", () => {
  assert.throws(() => sshFingerprintOf("ssh-rsa AAAAB3NzaC1yc2E="));
});

function publicKeyBytes(public_key: string): Buffer {
  return Buffer.from(public_key.split(FIELD_SEPARATOR)[1]!, "base64").subarray(
    -SEED_CHECK_PUBLIC_KEY_BYTES,
  );
}

function withPublicKey(private_key: string, from: Buffer, to: Buffer): string {
  const lines = private_key.trim().split(LINE_END);
  const body = Buffer.from(lines.slice(1, -1).join(""), "base64");
  for (
    let index = body.indexOf(from);
    index !== NOT_FOUND_INDEX;
    index = body.indexOf(from, index + to.length)
  )
    to.copy(body, index);
  const text = body.toString("base64");
  const armored: string[] = [];
  for (let index = 0; index < text.length; index += SEED_CHECK_LINE_LENGTH)
    armored.push(text.slice(index, index + SEED_CHECK_LINE_LENGTH));
  return [lines[0]!, ...armored, lines.at(-1)!].join(LINE_END) + LINE_END;
}

test("sshPublicKeyOf refuses a key whose public key does not derive from its seed", () => {
  const key = generateSshKey("alpha");
  const other = generateSshKey("beta");
  const tampered = withPublicKey(
    key.private_key,
    publicKeyBytes(key.public_key),
    publicKeyBytes(other.public_key),
  );
  assert.notEqual(tampered, key.private_key);
  assert.throws(() => sshPublicKeyOf(tampered), /seed/);
});
