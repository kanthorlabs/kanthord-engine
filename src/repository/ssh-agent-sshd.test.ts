import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { background } from "../kernel/context.ts";
import { withSshAgent, type SshAccess } from "./ssh-agent.ts";
import { generateSshKey } from "./ssh-key.ts";
import {
  createBareRepository,
  startTestSshd,
  TEST_REPOSITORY_FILE,
  TEST_REPOSITORY_TEXT,
  TEST_SSHD_HOST,
} from "./test-sshd.ts";
import { temporary } from "../kernel/test-support.ts";

const execFileAsync = promisify(execFile);
const DEADLINE_MS = 30_000;
const HOST_KEY_CHANGED = "REMOTE HOST IDENTIFICATION HAS CHANGED";
const HOST_KEY_FAILED = "Host key verification failed";
const KEY_REFUSED = "Permission denied (publickey)";
const NO_OUTPUT = "";

delete process.env.SSH_AUTH_SOCK;
delete process.env.SSH_AGENT_PID;

async function cloneThrough(
  access: SshAccess,
  url: string,
  target: string,
): Promise<string> {
  return withSshAgent(access, background, DEADLINE_MS, async (env) => {
    try {
      await execFileAsync("git", ["clone", "-q", url, target], { env });
      return NO_OUTPUT;
    } catch (error) {
      return (error as { stderr?: string }).stderr ?? String(error);
    }
  });
}

test("withSshAgent clones from a local sshd with a pinned host key", async (t) => {
  const sshd = await startTestSshd(t);
  const bare = await createBareRepository(t);
  const key = generateSshKey("sshd");
  await sshd.authorize(key.public_key);
  const target = join(temporary(t), "clone");
  const stderr = await cloneThrough(
    { ...key, known_hosts: sshd.known_hosts, port: sshd.port },
    sshd.url(bare),
    target,
  );
  assert.equal(stderr, NO_OUTPUT);
  assert.equal(
    await readFile(join(target, TEST_REPOSITORY_FILE), "utf8"),
    TEST_REPOSITORY_TEXT,
  );
});

test("withSshAgent refuses a host whose key differs from the pin", async (t) => {
  const sshd = await startTestSshd(t);
  const bare = await createBareRepository(t);
  const key = generateSshKey("sshd");
  await sshd.authorize(key.public_key);
  const other = generateSshKey("other").public_key.split(" ");
  const wrong = `[${TEST_SSHD_HOST}]:${sshd.port} ${other[0]} ${other[1]}\n`;
  const stderr = await cloneThrough(
    { ...key, known_hosts: wrong, port: sshd.port },
    sshd.url(bare),
    join(temporary(t), "clone"),
  );
  assert.match(stderr, new RegExp(HOST_KEY_CHANGED));
});

test("withSshAgent refuses a host with no pin", async (t) => {
  const sshd = await startTestSshd(t);
  const bare = await createBareRepository(t);
  const key = generateSshKey("sshd");
  await sshd.authorize(key.public_key);
  const stderr = await cloneThrough(
    { ...key, known_hosts: "", port: sshd.port },
    sshd.url(bare),
    join(temporary(t), "clone"),
  );
  assert.match(stderr, new RegExp(HOST_KEY_FAILED));
  assert.doesNotMatch(stderr, new RegExp(HOST_KEY_CHANGED));
});

test("withSshAgent offers only its own key", async (t) => {
  const sshd = await startTestSshd(t);
  const bare = await createBareRepository(t);
  await sshd.authorize(generateSshKey("authorized").public_key);
  const stderr = await cloneThrough(
    {
      ...generateSshKey("other"),
      known_hosts: sshd.known_hosts,
      port: sshd.port,
    },
    sshd.url(bare),
    join(temporary(t), "clone"),
  );
  assert.match(stderr, new RegExp(KEY_REFUSED.replace(/[()]/g, "\\$&")));
});

test("the SSH command reads no path under the home directory", async (t) => {
  const sshd = await startTestSshd(t);
  const key = generateSshKey("sshd");
  await sshd.authorize(key.public_key);
  const home = userInfo().homedir;
  const output = await withSshAgent(
    { ...key, known_hosts: sshd.known_hosts, port: sshd.port },
    background,
    DEADLINE_MS,
    async (env) => {
      const command = `${env.GIT_SSH_COMMAND} -vvv -T -p ${sshd.port} ${sshd.user}@${TEST_SSHD_HOST} true`;
      const { stderr } = await execFileAsync("sh", ["-c", command], { env });
      return stderr;
    },
  );
  assert.match(output, /Authenticated to/);
  assert.ok(home);
  assert.equal(output.includes(home), false);
});
