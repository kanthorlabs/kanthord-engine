import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { background } from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { isolatedGitEnvironment } from "../kernel/git-environment.ts";
import { ResourceFailureReason } from "../kernel/health.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  clone,
  cloneSnapshot,
  fetchAndCheckout,
  fetchBase,
  gitLsRemote,
  GitStage,
  GitWriteError,
  landedOn,
  pushNodeBranch,
  pushSnapshotFresh,
  readFilesAtCommit,
  resolveBranchCommit,
  squashPushFresh,
} from "./connector.ts";
import { RepositoryFileState } from "./contract.ts";
import {
  gitFailureReason,
  PushRefusalKind,
  pushRefusalOf,
} from "./git-failure.ts";
import { type SshAccess, SshAgentErrorCode } from "./ssh-agent.ts";
import { generateSshKey } from "./ssh-key.ts";
import {
  createBareRepository,
  startTestSshd,
  TEST_REPOSITORY_FILE,
  TEST_REPOSITORY_TEXT,
} from "./sshd-test-support.ts";

const execFileAsync = promisify(execFile);
const DEADLINE_MS = 30_000;
const BASE_BRANCH = "main";
const NODE_BRANCH = "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SNAPSHOT_BRANCH = "kanthord/snapshot";
const NODE_FILE = "node.md";
const NODE_TEXT = "node\n";
const ABSENT_FILE = "absent.md";
const LINK_FILE = "link.md";
const UNPARSABLE_KEY = "not an SSH key\n";
const MAX_BYTES = 1024;
const HOOK_MODE = 0o755;
const deadlineAt = () => Date.now() + DEADLINE_MS;
const NODE_ID = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HEADER = "feat: ship accounts";
const USER_GREETING =
  "Hi octocat! You have successfully authenticated, but GitHub does not provide shell access.";
const DEPLOY_GREETING =
  "Hi kanthorlabs/kanthord-engine! You have successfully authenticated, but GitHub does not provide shell access.";

delete process.env.SSH_AUTH_SOCK;
delete process.env.SSH_AGENT_PID;

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: directory,
    env: isolatedGitEnvironment(process.env),
  });
  return stdout.trim();
}

function greetingOption(greeting: string): string {
  const script = `if [ -z "$SSH_ORIGINAL_COMMAND" ]; then echo "${greeting}" >&2; exit 1; fi; exec sh -c "$SSH_ORIGINAL_COMMAND"`;
  return `command="${script.replaceAll('"', '\\"')}" `;
}

async function sshRemote(t: TestContext, greeting: string | null = null) {
  const sshd = await startTestSshd(t);
  const bare = await createBareRepository(t);
  await git(bare, ["config", "uploadpack.allowFilter", "true"]);
  await git(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const key = generateSshKey("connector");
  await sshd.authorize(
    (greeting === null ? "" : greetingOption(greeting)) + key.public_key,
  );
  const ssh: SshAccess = {
    ...key,
    known_hosts: sshd.known_hosts,
    port: sshd.port,
  };
  return { address: sshd.url(bare), bare, ssh, sshd };
}

async function nodeCommit(
  t: TestContext,
  address: string,
  ssh: SshAccess,
): Promise<{ work: string; commit: string }> {
  const work = join(temporary(t), "work");
  await execFileAsync("mkdir", [work]);
  await clone(address, work, background, DEADLINE_MS, ssh);
  await fetchAndCheckout(
    work,
    NODE_BRANCH,
    BASE_BRANCH,
    false,
    [],
    null,
    background,
    DEADLINE_MS,
    ssh,
  );
  await writeFile(join(work, NODE_FILE), NODE_TEXT);
  await symlink(NODE_FILE, join(work, LINK_FILE));
  await git(work, ["add", NODE_FILE, LINK_FILE]);
  await git(work, ["commit", "-q", "-m", "node"]);
  await pushNodeBranch(work, NODE_BRANCH, background, DEADLINE_MS, ssh);
  return { work, commit: await git(work, ["rev-parse", "HEAD"]) };
}

test("the connector reads, clones, fetches and pushes a node branch through the SSH agent", async (t) => {
  const { address, bare, ssh } = await sshRemote(t);
  await gitLsRemote(address, background, DEADLINE_MS, ssh);
  const { work, commit } = await nodeCommit(t, address, ssh);
  assert.equal(await git(bare, ["rev-parse", NODE_BRANCH]), commit);
  assert.equal(
    await fetchBase(work, BASE_BRANCH, background, DEADLINE_MS, ssh),
    await git(bare, ["rev-parse", BASE_BRANCH]),
  );
  const snapshot = join(temporary(t), "snapshot");
  await execFileAsync("mkdir", [snapshot]);
  assert.equal(
    await cloneSnapshot(
      address,
      commit,
      snapshot,
      background,
      DEADLINE_MS,
      ssh,
    ),
    commit,
  );
  assert.equal(await readFile(join(snapshot, NODE_FILE), "utf8"), NODE_TEXT);
});

test("the connector reads, clones, fetches and pushes an scp address on the port of the SSH access", async (t) => {
  const { bare, ssh, sshd } = await sshRemote(t);
  const address = sshd.scpUrl(bare);
  await gitLsRemote(address, background, DEADLINE_MS, ssh);
  const { commit } = await nodeCommit(t, address, ssh);
  assert.equal(await git(bare, ["rev-parse", NODE_BRANCH]), commit);
});

test("the connector squashes, pushes a snapshot and reads the landing through the SSH agent", async (t) => {
  const { address, bare, ssh } = await sshRemote(t);
  const { commit } = await nodeCommit(t, address, ssh);
  await pushSnapshotFresh(
    { address, branch: SNAPSHOT_BRANCH, commit },
    background,
    deadlineAt(),
    ssh,
  );
  assert.equal(await git(bare, ["rev-parse", SNAPSHOT_BRANCH]), commit);
  const landed = await squashPushFresh(
    squashInput(address, commit),
    background,
    deadlineAt(),
    ssh,
  );
  assert.equal(await git(bare, ["rev-parse", BASE_BRANCH]), landed.commit);
  assert.deepEqual(
    await landedOn(
      { address, branch: BASE_BRANCH, commit },
      background,
      deadlineAt(),
      ssh,
    ),
    { landed: true, first_parent: landed.commit, base_moved: false },
  );
});

function squashInput(address: string, commit: string) {
  return {
    address,
    base_branch: BASE_BRANCH,
    commit,
    node_id: NODE_ID,
    header: HEADER,
  };
}

async function landedIdentity(bare: string, commit: string): Promise<string> {
  return git(bare, ["log", "-1", "--format=%an <%ae> %cn <%ce>", commit]);
}

test("a pre-receive hook that prints GH013 is a rule refusal of the land", async (t) => {
  const { address, bare, ssh } = await sshRemote(t);
  const { commit } = await nodeCommit(t, address, ssh);
  const hook = join(bare, "hooks", "pre-receive");
  await writeFile(
    hook,
    "#!/bin/sh\necho 'GH013: Repository rule violations found for refs/heads/main.' >&2\nexit 1\n",
  );
  await chmod(hook, HOOK_MODE);
  const failure = await squashPushFresh(
    squashInput(address, commit),
    background,
    deadlineAt(),
    ssh,
  ).then(
    () => assert.fail("A refused push must fail."),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof GitWriteError);
  assert.equal(failure.stage, GitStage.Push);
  const refusal = pushRefusalOf(failure);
  assert.equal(refusal?.kind, PushRefusalKind.Rule);
  assert.match(refusal.detail, /GH013: Repository rule violations/);
});

test("the author and the committer are the account that the greeting of the key names", async (t) => {
  const { address, bare, ssh } = await sshRemote(t, USER_GREETING);
  const { commit } = await nodeCommit(t, address, ssh);
  const landed = await squashPushFresh(
    squashInput(address, commit),
    background,
    deadlineAt(),
    ssh,
  );
  const account = "octocat <octocat@users.noreply.github.com>";
  assert.equal(
    await landedIdentity(bare, landed.commit),
    `${account} ${account}`,
  );
});

test("a deploy key greeting gives the author of the assessed commit", async (t) => {
  const { address, bare, ssh } = await sshRemote(t, DEPLOY_GREETING);
  const { commit } = await nodeCommit(t, address, ssh);
  const landed = await squashPushFresh(
    squashInput(address, commit),
    background,
    deadlineAt(),
    ssh,
  );
  const author = await git(bare, ["log", "-1", "--format=%an <%ae>", commit]);
  assert.equal(
    await landedIdentity(bare, landed.commit),
    `${author} ${author}`,
  );
});

test("readFilesAtCommit reads a blob and a symlink outside the first fetch through the SSH agent", async (t) => {
  const { address, ssh } = await sshRemote(t);
  const { commit } = await nodeCommit(t, address, ssh);
  assert.equal(
    await resolveBranchCommit(
      address,
      NODE_BRANCH,
      background,
      DEADLINE_MS,
      ssh,
    ),
    commit,
  );
  const files = await readFilesAtCommit(
    address,
    commit,
    [NODE_FILE, LINK_FILE, TEST_REPOSITORY_FILE, ABSENT_FILE],
    MAX_BYTES,
    background,
    DEADLINE_MS,
    ssh,
  );
  assert.deepEqual(files, [
    { path: NODE_FILE, state: RepositoryFileState.Present, text: NODE_TEXT },
    { path: LINK_FILE, state: RepositoryFileState.Present, text: NODE_TEXT },
    {
      path: TEST_REPOSITORY_FILE,
      state: RepositoryFileState.Present,
      text: TEST_REPOSITORY_TEXT,
    },
    { path: ABSENT_FILE, state: RepositoryFileState.Absent, text: null },
  ]);
});

test("a key that the SSH agent refuses throws ssh_agent_failed before the push and classifies as identity_unavailable", async (t) => {
  const { address, ssh } = await sshRemote(t);
  const refused: SshAccess = {
    ...ssh,
    private_key: UNPARSABLE_KEY,
  };
  const read = await gitLsRemote(
    address,
    background,
    DEADLINE_MS,
    refused,
  ).then(
    () => assert.fail("A refused key must fail."),
    (error: unknown) => error,
  );
  assert.ok(read instanceof Diagnostic);
  assert.equal(read.code, SshAgentErrorCode.Failed);
  assert.equal(
    gitFailureReason(read),
    ResourceFailureReason.IdentityUnavailable,
  );
  const write = await pushSnapshotFresh(
    { address, branch: SNAPSHOT_BRANCH, commit: "a".repeat(40) },
    background,
    Date.now() + DEADLINE_MS,
    refused,
  ).then(
    () => assert.fail("A refused key must fail."),
    (error: unknown) => error,
  );
  assert.ok(write instanceof GitWriteError);
  assert.equal(write.stage, GitStage.BeforePush);
  assert.equal(
    gitFailureReason(write),
    ResourceFailureReason.IdentityUnavailable,
  );
});
