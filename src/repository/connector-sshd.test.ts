import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, symlink, writeFile } from "node:fs/promises";
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
  mergePushFresh,
  pushNodeBranch,
  pushSnapshotFresh,
  readFilesAtCommit,
  resolveBranchCommit,
} from "./connector.ts";
import { RepositoryFileState } from "./contract.ts";
import { gitFailureReason } from "./git-failure.ts";
import { sshPortOf } from "./platform.ts";
import { SshAgentErrorCode, type SshAccess } from "./ssh-agent.ts";
import { generateSshKey } from "./ssh-key.ts";
import {
  createBareRepository,
  startTestSshd,
  TEST_REPOSITORY_FILE,
  TEST_REPOSITORY_TEXT,
  TEST_SSHD_HOST,
} from "./test-sshd.ts";

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

delete process.env.SSH_AUTH_SOCK;
delete process.env.SSH_AGENT_PID;

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: directory,
    env: isolatedGitEnvironment(process.env),
  });
  return stdout.trim();
}

async function sshRemote(t: TestContext) {
  const sshd = await startTestSshd(t);
  const bare = await createBareRepository(t);
  await git(bare, ["config", "uploadpack.allowFilter", "true"]);
  await git(bare, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const key = generateSshKey("connector");
  await sshd.authorize(key.public_key);
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

test("the connector reads, clones and pushes an scp address on the port of the port table", async (t) => {
  const { bare, ssh, sshd } = await sshRemote(t);
  const address = sshd.scpUrl(bare);
  const table: SshAccess = {
    ...ssh,
    port: sshPortOf(TEST_SSHD_HOST, new Map([[TEST_SSHD_HOST, sshd.port]])),
  };
  await gitLsRemote(address, background, DEADLINE_MS, table);
  const { commit } = await nodeCommit(t, address, table);
  assert.equal(await git(bare, ["rev-parse", NODE_BRANCH]), commit);
});

test("the connector merges, pushes a snapshot and reads the landing through the SSH agent", async (t) => {
  const { address, bare, ssh } = await sshRemote(t);
  const { commit } = await nodeCommit(t, address, ssh);
  const deadlineAt = () => Date.now() + DEADLINE_MS;
  await pushSnapshotFresh(
    { address, branch: SNAPSHOT_BRANCH, commit },
    background,
    deadlineAt(),
    ssh,
  );
  assert.equal(await git(bare, ["rev-parse", SNAPSHOT_BRANCH]), commit);
  const merged = await mergePushFresh(
    { address, base_branch: BASE_BRANCH, commit },
    background,
    deadlineAt(),
    ssh,
  );
  assert.equal(await git(bare, ["rev-parse", BASE_BRANCH]), merged.commit);
  assert.deepEqual(
    await landedOn(
      { address, branch: BASE_BRANCH, commit },
      background,
      deadlineAt(),
      ssh,
    ),
    { landed: true, first_parent: merged.commit },
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
