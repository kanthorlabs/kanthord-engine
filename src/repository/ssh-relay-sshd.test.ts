import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { background } from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { isolatedGitEnvironment } from "../kernel/git-environment.ts";
import { temporary } from "../kernel/test-support.ts";
import { clone, fetchBase, gitLsRemote, pushNodeBranch } from "./connector.ts";
import {
  SSH_SIGN_USER,
  SshSignErrorCode,
  type SshKeyAccess,
  type SshRelayAccess,
} from "./contract.ts";
import { withSshAgent } from "./ssh-agent.ts";
import { generateSshKey } from "./ssh-key.ts";
import { relayedSignature, SshAuthenticationMethod } from "./ssh-sign.ts";
import {
  createBareRepository,
  startTestSshd,
  TEST_REPOSITORY_FILE,
  TEST_REPOSITORY_TEXT,
  TEST_SSHD_HOST,
  type TestSshd,
} from "./test-sshd.ts";

const execFileAsync = promisify(execFile);
const DEADLINE_MS = 30_000;
const BASE_BRANCH = "main";
const NODE_BRANCH = "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PLAIN_BRANCH = "plain";
const NODE_FILE = "node.md";
const NODE_TEXT = "node\n";
const SESSION_BIND_REFUSED = /ssh_agent_bind_hostkey.*agent refused operation/;
const AUTHENTICATED = /Authenticated to/;
const KEY_REFUSED = /Permission denied \(publickey\)/;
const NO_SIGNATURES = 0;
const GIT_FAILED = "repository.connector.git_failed";
const OTHER_USER = "not-the-login-user";
const MISSING_REPOSITORY = "missing";
const RELAY_LINE = /ssh relay:/;
const RELAY_REFUSED = /ssh relay: worker\.ssh\.sign_refused/;

delete process.env.SSH_AUTH_SOCK;
delete process.env.SSH_AGENT_PID;

interface RelayHarness {
  sshd: TestSshd;
  bare: string;
  access: SshRelayAccess;
  methods: string[];
}

async function relayHarness(
  t: TestContext,
  serverKnownHosts?: string,
  user?: string,
): Promise<RelayHarness> {
  const sshd = await startTestSshd(t);
  const bare = await createBareRepository(t);
  const key = generateSshKey("relay");
  await sshd.authorize(key.public_key);
  const held: SshKeyAccess = {
    ...key,
    known_hosts: serverKnownHosts ?? sshd.known_hosts,
    port: sshd.port,
  };
  const methods: string[] = [];
  const access: SshRelayAccess = {
    relay: async (data) => {
      methods.push(
        data.includes(Buffer.from(SshAuthenticationMethod.HostBound))
          ? SshAuthenticationMethod.HostBound
          : SshAuthenticationMethod.PublicKey,
      );
      return relayedSignature(held, data, user ?? sshd.user);
    },
    public_key: key.public_key,
    known_hosts: sshd.known_hosts,
    port: sshd.port,
  };
  return { sshd, bare, access, methods };
}

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: directory,
    env: isolatedGitEnvironment(process.env),
  });
  return stdout.trim();
}

test("plain git clones, pushes and fetches through the relay with a host-bound signature", async (t) => {
  const h = await relayHarness(t);
  const url = h.sshd.url(h.bare);
  const root = temporary(t);
  const work = join(root, "work");
  await withSshAgent(h.access, background, DEADLINE_MS, async (env) => {
    await execFileAsync("git", ["clone", "-q", url, work], { env });
    await writeFile(join(work, NODE_FILE), NODE_TEXT);
    await git(work, ["add", NODE_FILE]);
    await git(work, ["commit", "-q", "-m", "node"]);
    await execFileAsync(
      "git",
      ["push", "-q", "origin", `HEAD:refs/heads/${PLAIN_BRANCH}`],
      { cwd: work, env },
    );
    await execFileAsync("git", ["fetch", "-q", "origin"], { cwd: work, env });
  });
  assert.equal(
    await readFile(join(work, TEST_REPOSITORY_FILE), "utf8"),
    TEST_REPOSITORY_TEXT,
  );
  assert.equal(
    await git(h.bare, ["rev-parse", PLAIN_BRANCH]),
    await git(work, ["rev-parse", `origin/${PLAIN_BRANCH}`]),
  );
  assert.ok(h.methods.length > NO_SIGNATURES);
  assert.ok(
    h.methods.every((method) => method === SshAuthenticationMethod.HostBound),
  );
});

test("the connector clones, pushes a node branch, fetches and lists through the relay", async (t) => {
  const h = await relayHarness(t);
  const url = h.sshd.url(h.bare);
  const directory = temporary(t);
  await clone(url, directory, background, DEADLINE_MS, h.access);
  await git(directory, ["checkout", "-q", "-b", NODE_BRANCH]);
  await writeFile(join(directory, NODE_FILE), NODE_TEXT);
  await git(directory, ["add", NODE_FILE]);
  await git(directory, ["commit", "-q", "-m", "node"]);
  await pushNodeBranch(
    directory,
    NODE_BRANCH,
    background,
    DEADLINE_MS,
    h.access,
  );
  assert.equal(
    await git(h.bare, ["rev-parse", NODE_BRANCH]),
    await git(directory, ["rev-parse", "HEAD"]),
  );
  assert.equal(
    await fetchBase(directory, BASE_BRANCH, background, DEADLINE_MS, h.access),
    await git(h.bare, ["rev-parse", BASE_BRANCH]),
  );
  await gitLsRemote(url, background, DEADLINE_MS, h.access);
});

test("OpenSSH continues after SSH_AGENT_FAILURE to session-bind and authenticates through the relay", async (t) => {
  const h = await relayHarness(t);
  const stderr = await withSshAgent(
    h.access,
    background,
    DEADLINE_MS,
    async (env) => {
      const command = `${env.GIT_SSH_COMMAND} -vvv -T -p ${h.sshd.port} ${h.sshd.user}@${TEST_SSHD_HOST} true`;
      const { stderr: output } = await execFileAsync("sh", ["-c", command], {
        env,
      });
      return output;
    },
  );
  assert.match(stderr, SESSION_BIND_REFUSED);
  assert.match(stderr, AUTHENTICATED);
});

test("a server refusal of the relayed payload fails the git operation", async (t) => {
  const other = generateSshKey("other-host").public_key.split(" ");
  const h = await relayHarness(
    t,
    `[${TEST_SSHD_HOST}]:0 ${other[0]} ${other[1]}\n`,
  );
  const failure = await withSshAgent(
    h.access,
    background,
    DEADLINE_MS,
    async (env) =>
      execFileAsync(
        "git",
        ["clone", "-q", h.sshd.url(h.bare), join(temporary(t), "clone")],
        { env },
      ).then(
        () => "",
        (error: { stderr?: string }) => error.stderr ?? "",
      ),
  );
  assert.match(failure, KEY_REFUSED);
  assert.ok(h.methods.length > NO_SIGNATURES);
});

test("the git failure cause holds the last relay error", async (t) => {
  const h = await relayHarness(t, undefined, OTHER_USER);
  await assert.rejects(
    clone(h.sshd.url(h.bare), temporary(t), background, DEADLINE_MS, h.access),
    (error) => {
      assert(error instanceof Diagnostic);
      assert.equal(error.code, GIT_FAILED);
      assert(error.cause instanceof Error);
      assert.match(error.cause.message, KEY_REFUSED);
      assert.match(error.cause.message, RELAY_REFUSED);
      assert(error.cause.cause instanceof OperationError);
      assert.equal(error.cause.cause.code, SshSignErrorCode.Refused);
      return true;
    },
  );
});

test("a git failure without a relay error keeps its cause", async (t) => {
  const h = await relayHarness(t);
  await assert.rejects(
    clone(
      h.sshd.url(join(h.bare, MISSING_REPOSITORY)),
      temporary(t),
      background,
      DEADLINE_MS,
      h.access,
    ),
    (error) => {
      assert(error instanceof Diagnostic);
      assert.equal(error.code, GIT_FAILED);
      assert(error.cause instanceof Error);
      assert.doesNotMatch(error.cause.message, RELAY_LINE);
      assert.equal(error.cause.cause, undefined);
      return true;
    },
  );
});

test("plain git pushes and fetches through the relay with an unbound publickey signature", async (t) => {
  const h = await relayHarness(t);
  const url = h.sshd.url(h.bare);
  const work = join(temporary(t), "work");
  await withSshAgent(h.access, background, DEADLINE_MS, async (agentEnv) => {
    const env = {
      ...agentEnv,
      GIT_SSH_COMMAND: `${agentEnv.GIT_SSH_COMMAND} -o PubkeyAuthentication=unbound`,
    };
    await execFileAsync("git", ["clone", "-q", url, work], { env });
    await writeFile(join(work, NODE_FILE), NODE_TEXT);
    await git(work, ["add", NODE_FILE]);
    await git(work, ["commit", "-q", "-m", "node"]);
    await execFileAsync(
      "git",
      ["push", "-q", "origin", `HEAD:refs/heads/${PLAIN_BRANCH}`],
      { cwd: work, env },
    );
    await execFileAsync("git", ["fetch", "-q", "origin"], { cwd: work, env });
  });
  assert.equal(
    await git(h.bare, ["rev-parse", PLAIN_BRANCH]),
    await git(work, ["rev-parse", `origin/${PLAIN_BRANCH}`]),
  );
  assert.ok(h.methods.length > NO_SIGNATURES);
  assert.ok(
    h.methods.every((method) => method === SshAuthenticationMethod.PublicKey),
  );
});

test("the production user name git refuses a login as another user", async (t) => {
  const h = await relayHarness(t, undefined, SSH_SIGN_USER);
  assert.notEqual(h.sshd.user, SSH_SIGN_USER);
  const failure = await withSshAgent(
    h.access,
    background,
    DEADLINE_MS,
    async (env) =>
      execFileAsync(
        "git",
        ["clone", "-q", h.sshd.url(h.bare), join(temporary(t), "clone")],
        { env },
      ).then(
        () => "",
        (error: { stderr?: string }) => error.stderr ?? "",
      ),
  );
  assert.match(failure, KEY_REFUSED);
});
