import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { test } from "node:test";
import { basename, dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import * as connector from "../../repository/connector.ts";
import {
  fixtureTemplate,
  hostEnvironment,
  temporary,
} from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { nodeBranchOf } from "../../repository/node-branch.ts";
import { generateSshKey } from "../../repository/ssh-key.ts";
import { DEFAULT_SSH_PORT } from "../../repository/sshd-test-support.ts";
import {
  CHECKOUTS_DIRECTORY,
  handedSshAccess,
  SCRATCH_DIRECTORY,
  WorkspaceKind,
  WorkspaceRoot,
} from "./workspace.ts";
import { PoolClass } from "./tree-pool.ts";
import {
  everyBindingSshAccess,
  LOCAL_GIT_SSH_ACCESS,
  repositorySetup,
  testSshAccess,
  transport,
} from "./test-support.ts";
import type { RepositoryTransport } from "../contract.ts";
import type { SshAccess } from "../../repository/contract.ts";

type ImplementInput = Parameters<WorkspaceRoot["prepareImplement"]>[0];
async function prepareOne(
  workspace: WorkspaceRoot,
  input: Omit<ImplementInput, "pushed" | "repositories"> & {
    pushed: boolean;
    repository: ImplementInput["repositories"][number];
  },
) {
  const { repository, pushed, ...rest } = input;
  const prepared = await workspace.prepareImplement({
    ...rest,
    pushed: new Set(pushed ? [repository.binding_id] : []),
    repositories: [repository],
  });
  const [checkout] = prepared.checkouts;
  assert.ok(checkout);
  assert.equal(prepared.root, checkout.directory);
  return { ...checkout, nodeBranch: input.nodeBranch };
}
const FIRST_ATTEMPT = 1;
const PREPARATION_KINDS = 3;
const ORIGIN_NAME = "origin";
const SEED_NAME = "seed";
const GIT_DEADLINE_MS = 60_000;
const env = hostEnvironment();

test("workspace root audits private mode and keys refuse foreign identities", (t) => {
  const expectedBranch = "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA";
  const state = temporary(t);
  const workspace = WorkspaceRoot.open(state);
  const mode = 0o700;
  assert.equal(statSync(workspace.root).mode & 0o777, mode);
  assert.throws(() => workspace.nodeKey("../x"));
  assert.throws(() => workspace.executionKey(createIdentity("node")));
  assert.throws(() =>
    workspace.nodeDirectory(createIdentity("execution"), "repo"),
  );
  assert.throws(() => workspace.nodeDirectory(createIdentity("node"), "../x"));
  assert.equal(
    nodeBranchOf("node_01ARZ3NDEKTSV4RRFFQ69G5FAA", FIRST_ATTEMPT),
    expectedBranch,
  );
  chmodSync(workspace.root, 0o755);
  assert.throws(() => WorkspaceRoot.open(state), {
    code: "system.files.invalid_permissions",
  });
});

test("the workspace root keeps an idle node workspace and removes only a released execution workspace", (t) => {
  const workspace = WorkspaceRoot.open(temporary(t));
  const idle = workspace.nodeKey(createIdentity("node"));
  const held = workspace.nodeKey(createIdentity("node"));
  const execution = workspace.executionKey(createIdentity("execution"));
  const now = Date.now();
  for (const key of [idle, held, execution]) mkdirSync(key, { mode: 0o700 });
  const idleSince = new Date(now - 365 * 86400000);
  for (const key of [idle, held]) utimesSync(key, idleSince, idleSince);
  workspace.hold(held);
  assert.throws(() => workspace.hold(held));
  workspace.release(held, WorkspaceKind.Node);
  assert.ok(statSync(held).mtimeMs > idleSince.getTime());
  workspace.hold(execution);
  workspace.release(execution, WorkspaceKind.Execution);
  assert.equal(existsSync(execution), false);
  assert.equal(existsSync(idle), true);
  assert.equal(existsSync(held), true);
});

test("workspace preparation refreshes implement branches and takes review trees for snapshots and examine", async (t) => {
  const state = temporary(t);
  const origin = join(state, "origin");
  mkdirSync(origin);
  const git = simpleGit(origin);
  await git.init();
  await git.raw(["checkout", "-b", "main"]);
  const commit = async (directory: string, name: string) => {
    writeFileSync(join(directory, "file"), name);
    await simpleGit(directory).add("file");
    await simpleGit(directory).raw([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      name,
    ]);
    return (await simpleGit(directory).revparse(["HEAD"])).trim();
  };
  const base = await commit(origin, "base");
  const workspace = WorkspaceRoot.open(state);
  const nodeId = createIdentity("node");
  const repository = {
    binding_id: createIdentity("binding"),
    name: "todoapp-repo",
    address: origin,
    strategy: { base_branch: "main" },
  };
  const common = {
    env,
    transport,
    sshAccess: everyBindingSshAccess,
    context: background,
    deadlineMs: GIT_DEADLINE_MS,
  };
  const first = await prepareOne(workspace, {
    ...common,
    nodeId,
    nodeBranch: nodeBranchOf(nodeId, FIRST_ATTEMPT),
    pushed: false,
    repository,
  });
  assert.equal(first.head, base);
  const pushed = await commit(first.directory, "pushed");
  await connector.pushNodeBranch(
    first.directory,
    first.nodeBranch,
    background,
    10000,
    LOCAL_GIT_SSH_ACCESS,
  );
  await commit(first.directory, "unpushed");
  workspace.release(workspace.nodeKey(nodeId), WorkspaceKind.Node);
  const second = await prepareOne(workspace, {
    ...common,
    nodeId,
    nodeBranch: nodeBranchOf(nodeId, FIRST_ATTEMPT),
    pushed: false,
    repository,
  });
  assert.equal(second.directory, first.directory);
  assert.equal(second.head, pushed);
  workspace.release(workspace.nodeKey(nodeId), WorkspaceKind.Node);
  const snapshot = await workspace.prepareSnapshots({
    ...common,
    executionId: createIdentity("execution"),
    nodeId,
    snapshots: [{ repository, commit: pushed }],
  });
  assert.deepEqual(snapshot.tested_input, {
    kind: "repository",
    binding_id: repository.binding_id,
    commit: pushed,
  });
  assert.equal(
    snapshot.directory,
    join(snapshot.key, CHECKOUTS_DIRECTORY, repository.name),
  );
  workspace.release(snapshot.key, snapshot.kind);
  const another = {
    ...repository,
    binding_id: createIdentity("binding"),
    name: "other-repo",
  };
  await t.test(
    "an examine node with two bindings checks out each base-branch head under checkouts/ and records one tested commit for each",
    async () => {
      const examine = await workspace.prepareExamine({
        ...common,
        executionId: createIdentity("execution"),
        nodeId,
        repositories: [repository, another],
      });
      assert.deepEqual(
        examine.tested_input,
        [repository, another].map(({ binding_id }) => ({
          kind: "repository",
          binding_id,
          commit: base,
        })),
      );
      assert.equal(examine.directory, join(examine.key, CHECKOUTS_DIRECTORY));
      assert.deepEqual(
        examine.checkouts,
        [repository, another].map(({ name }) => ({
          name,
          directory: join(examine.key, CHECKOUTS_DIRECTORY, name),
          base_branch: "main",
        })),
      );
      for (const name of [repository.name, another.name])
        assert.ok(existsSync(join(examine.directory, name, ".git")));
      workspace.release(examine.key, examine.kind);
      assert.equal(existsSync(examine.key), false);
    },
  );
  await t.test(
    "an examine node with one binding uses the checkout as the agent root",
    async () => {
      const examine = await workspace.prepareExamine({
        ...common,
        executionId: createIdentity("execution"),
        nodeId,
        repositories: [repository],
      });
      assert.deepEqual(examine.tested_input, {
        kind: "repository",
        binding_id: repository.binding_id,
        commit: base,
      });
      assert.equal(
        examine.directory,
        join(examine.key, CHECKOUTS_DIRECTORY, repository.name),
      );
      assert.ok(existsSync(join(examine.directory, ".git")));
      workspace.release(examine.key, examine.kind);
    },
  );
  const empty = await workspace.prepareExamine({
    ...common,
    executionId: createIdentity("execution"),
    nodeId,
    repositories: [],
  });
  assert.equal(empty.tested_input, null);
  assert.equal(empty.directory, empty.key);
  assert.equal(empty.kind, WorkspaceKind.Execution);
  workspace.release(empty.key, empty.kind);
  const failedId = createIdentity("node");
  await assert.rejects(
    prepareOne(workspace, {
      ...common,
      nodeId: failedId,
      nodeBranch: nodeBranchOf(failedId, FIRST_ATTEMPT),
      pushed: false,
      repository: { ...repository, address: join(state, "missing") },
    }),
  );
  const retried = await prepareOne(workspace, {
    ...common,
    nodeId: failedId,
    nodeBranch: nodeBranchOf(failedId, FIRST_ATTEMPT),
    pushed: false,
    repository,
  });
  assert.equal(retried.head, base);
  workspace.release(workspace.nodeKey(failedId), WorkspaceKind.Node);
});

test("every workspace git operation takes the SSH identity of its binding, and a binding without one runs no git", async (t) => {
  const workspace = WorkspaceRoot.open(temporary(t));
  const stop = new Error("test_stop_after_git");
  const used: { operation: string; ssh: SshAccess }[] = [];
  const recording: RepositoryTransport = {
    clone: async (_address, _directory, _context, _deadlineMs, ssh) => {
      used.push({ operation: "clone", ssh });
      throw stop;
    },
    cloneSnapshot: async (_a, _r, _d, _context, _deadlineMs, ssh) => {
      used.push({ operation: "clone_snapshot", ssh });
      throw stop;
    },
    refreshSnapshot: async () => assert.fail("The refresh must not run."),
    fetchAndCheckout: async () => assert.fail("The fetch must not run."),
    fetchBase: async () => assert.fail("The fetch must not run."),
    pushNodeBranch: async () => assert.fail("The push must not run."),
  };
  const repository = {
    binding_id: createIdentity("binding"),
    name: "todoapp-repo",
    address: "git@github.com:kanthorlabs/kanthord.git",
    strategy: { base_branch: "main" },
  };
  const sshAccess = testSshAccess([repository]);
  const access = sshAccess.get(repository.binding_id)!;
  const prepare = (held: ReadonlyMap<string, SshAccess>) => {
    const common = {
      transport: recording,
      sshAccess: held,
      context: background,
      deadlineMs: GIT_DEADLINE_MS,
    };
    return [
      prepareOne(workspace, {
        ...common,
        env,
        nodeId: createIdentity("node"),
        nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
        pushed: false,
        repository,
      }),
      workspace.prepareSnapshots({
        ...common,
        env,
        executionId: createIdentity("execution"),
        nodeId: createIdentity("node"),
        snapshots: [{ repository, commit: "head" }],
      }),
      workspace.prepareExamine({
        ...common,
        env,
        executionId: createIdentity("execution"),
        nodeId: createIdentity("node"),
        repositories: [repository],
      }),
    ];
  };
  for (const pending of prepare(sshAccess))
    await assert.rejects(pending, (error) => error === stop);
  assert.deepEqual(used, [
    { operation: "clone", ssh: access },
    { operation: "clone_snapshot", ssh: access },
    { operation: "clone_snapshot", ssh: access },
  ]);
  for (const pending of prepare(new Map()))
    await assert.rejects(pending, assert.AssertionError);
  assert.equal(used.length, PREPARATION_KINDS);
});

const SCRATCH_ENTRIES = 1;
const NO_UNTRACKED = 0;

test("an implement workspace excludes the scratch directory from git once", async (t) => {
  const state = temporary(t);
  const origin = join(state, "origin");
  mkdirSync(origin);
  const git = simpleGit(origin);
  await git.init();
  await git.raw(["checkout", "-b", "main"]);
  writeFileSync(join(origin, "file"), "base");
  await git.add("file");
  await git.raw([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "base",
  ]);
  const workspace = WorkspaceRoot.open(state);
  const nodeId = createIdentity("node");
  const input = {
    env,
    transport,
    sshAccess: everyBindingSshAccess,
    context: background,
    deadlineMs: GIT_DEADLINE_MS,
    nodeId,
    nodeBranch: nodeBranchOf(nodeId, FIRST_ATTEMPT),
    pushed: false,
    repository: {
      binding_id: createIdentity("binding"),
      name: "todoapp-repo",
      address: origin,
      strategy: { base_branch: "main" },
    },
  };
  const prepared = await prepareOne(workspace, input);
  workspace.release(workspace.nodeKey(nodeId), WorkspaceKind.Node);
  await prepareOne(workspace, input);
  const exclude = readFileSync(
    join(prepared.directory, ".git", "info", "exclude"),
    "utf8",
  );
  assert.equal(
    exclude.split("\n").filter((line) => line === SCRATCH_DIRECTORY).length,
    SCRATCH_ENTRIES,
  );
  mkdirSync(join(prepared.directory, SCRATCH_DIRECTORY));
  writeFileSync(join(prepared.directory, SCRATCH_DIRECTORY, "probe.mjs"), "x");
  assert.equal(
    (await simpleGit(prepared.directory).status()).not_added.length,
    NO_UNTRACKED,
  );
  workspace.release(workspace.nodeKey(nodeId), WorkspaceKind.Node);
});

const RESTART_ATTEMPT = 2;

async function commit(directory: string, file: string, value: string) {
  writeFileSync(join(directory, file), value);
  await simpleGit(directory).add(file);
  await simpleGit(directory).raw([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    value,
  ]);
  return (await simpleGit(directory).revparse(["HEAD"])).trim();
}

const restartTemplate = fixtureTemplate(async (root) => {
  const origin = join(root, ORIGIN_NAME);
  const seed = join(root, SEED_NAME);
  mkdirSync(origin);
  mkdirSync(seed);
  await simpleGit(origin).init(true);
  const git = simpleGit(seed);
  await git.raw(["init", "-b", "main"]);
  const base = await commit(seed, ".gitignore", "ignored.txt\n");
  await git.addRemote("origin", `../${ORIGIN_NAME}`);
  await git.push("origin", "main");
  return base;
});

async function restartFixture(t: test.TestContext) {
  const { root: state, built: base } = await restartTemplate(t);
  const origin = join(state, ORIGIN_NAME);
  const seed = join(state, SEED_NAME);
  const git = simpleGit(seed);
  const workspace = WorkspaceRoot.open(state);
  const nodeId = createIdentity("node");
  const repository = {
    binding_id: createIdentity("binding"),
    name: "todoapp-repo",
    address: origin,
    strategy: { base_branch: "main" },
  };
  const prepare = async (startAttempt: number, pushed = false) => {
    const prepared = await prepareOne(workspace, {
      env,
      transport,
      sshAccess: everyBindingSshAccess,
      context: background,
      deadlineMs: GIT_DEADLINE_MS,
      nodeId,
      nodeBranch: nodeBranchOf(nodeId, startAttempt),
      pushed,
      repository,
    });
    workspace.release(workspace.nodeKey(nodeId), WorkspaceKind.Node);
    return prepared;
  };
  const remoteHead = async (branch: string) =>
    (await simpleGit(origin).revparse([`refs/heads/${branch}`])).trim();
  const deleteRemote = (branch: string) =>
    simpleGit(origin).raw(["branch", "-D", branch]);
  return { origin, seed, base, commit, prepare, remoteHead, deleteRemote, git };
}

const missing = { code: connector.NODE_BRANCH_MISSING };

test("a continued attempt whose pushed node branch is gone stops and keeps its checkout", async (t) => {
  const h = await restartFixture(t);
  const first = await h.prepare(FIRST_ATTEMPT);
  const pushed = await h.commit(first.directory, "work", "pushed");
  await connector.pushNodeBranch(
    first.directory,
    first.nodeBranch,
    background,
    10000,
    LOCAL_GIT_SSH_ACCESS,
  );
  await h.deleteRemote(first.nodeBranch);
  await assert.rejects(h.prepare(FIRST_ATTEMPT), missing);
  await assert.rejects(h.prepare(FIRST_ATTEMPT), missing);
  assert.equal(
    (await simpleGit(first.directory).revparse(["HEAD"])).trim(),
    pushed,
  );
  await connector.pushNodeBranch(
    first.directory,
    first.nodeBranch,
    background,
    10000,
    LOCAL_GIT_SSH_ACCESS,
  );
  assert.equal((await h.prepare(FIRST_ATTEMPT)).head, pushed);
});

test("a recorded push stops a fresh workspace whose node branch is gone and a first execution starts from the base", async (t) => {
  const h = await restartFixture(t);
  await assert.rejects(h.prepare(FIRST_ATTEMPT, true), missing);
  assert.equal((await h.prepare(FIRST_ATTEMPT)).head, h.base);
});

test("a restart from the base branch starts from the base after the earlier node branch is gone", async (t) => {
  const h = await restartFixture(t);
  const first = await h.prepare(FIRST_ATTEMPT);
  await h.commit(first.directory, "work", "rejected");
  await connector.pushNodeBranch(
    first.directory,
    first.nodeBranch,
    background,
    10000,
    LOCAL_GIT_SSH_ACCESS,
  );
  await h.deleteRemote(first.nodeBranch);
  const restart = await h.prepare(RESTART_ATTEMPT);
  assert.equal(restart.nodeBranch, `${first.nodeBranch}-a2`);
  assert.equal(restart.head, h.base);
});

test("a restart from the base branch checks out the base, pushes a new node branch and leaves the earlier branch", async (t) => {
  const h = await restartFixture(t);
  const first = await h.prepare(FIRST_ATTEMPT);
  assert.equal(first.head, h.base);
  const earlier = await h.commit(first.directory, "work", "rejected");
  await connector.pushNodeBranch(
    first.directory,
    first.nodeBranch,
    background,
    10000,
    LOCAL_GIT_SSH_ACCESS,
  );
  const restart = await h.prepare(RESTART_ATTEMPT);
  assert.equal(restart.directory, first.directory);
  assert.equal(restart.nodeBranch, `${first.nodeBranch}-a2`);
  assert.equal(restart.head, h.base);
  const fresh = await h.commit(restart.directory, "work", "fresh");
  await connector.pushNodeBranch(
    restart.directory,
    restart.nodeBranch,
    background,
    10000,
    LOCAL_GIT_SSH_ACCESS,
  );
  assert.equal(await h.remoteHead(restart.nodeBranch), fresh);
  assert.equal(await h.remoteHead(first.nodeBranch), earlier);
  assert.equal(
    (await simpleGit(restart.directory).raw(["rev-list", fresh]))
      .split("\n")
      .includes(earlier),
    false,
  );
  const continued = await h.prepare(RESTART_ATTEMPT);
  assert.equal(continued.nodeBranch, restart.nodeBranch);
  assert.equal(continued.head, fresh);
});

test("a branch switch removes the scratch directory and ignored files and a checkout of the same branch keeps them", async (t) => {
  const h = await restartFixture(t);
  const first = await h.prepare(FIRST_ATTEMPT);
  const scratch = join(first.directory, SCRATCH_DIRECTORY);
  const ignored = join(first.directory, "ignored.txt");
  const untracked = join(first.directory, "untracked.txt");
  const leave = () => {
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, "probe.mjs"), "x");
    writeFileSync(ignored, "x");
    writeFileSync(untracked, "x");
  };
  leave();
  const same = await h.prepare(FIRST_ATTEMPT);
  assert.equal(same.directory, first.directory);
  assert.equal(existsSync(scratch), true);
  assert.equal(existsSync(ignored), true);
  assert.equal(existsSync(untracked), false);
  leave();
  await h.prepare(RESTART_ATTEMPT);
  assert.equal(existsSync(scratch), false);
  assert.equal(existsSync(ignored), false);
  assert.equal(existsSync(untracked), false);
});

function writeSetupRecordOf(directory: string, roots: readonly string[]) {
  writeFileSync(
    join(directory, ".git", "kanthord-setup.json"),
    JSON.stringify({ digest: "earlier", roots }),
  );
}

test("a branch switch keeps the recorded setup roots of the checkout", async (t) => {
  const h = await restartFixture(t);
  const first = await h.prepare(FIRST_ATTEMPT);
  const deps = join(first.directory, "deps");
  mkdirSync(deps);
  writeFileSync(join(deps, "a"), "x");
  const other = join(first.directory, "other");
  writeFileSync(other, "x");
  writeSetupRecordOf(first.directory, ["deps/"]);
  const inode = statSync(join(deps, "a")).ino;
  await h.prepare(RESTART_ATTEMPT);
  assert.equal(statSync(join(deps, "a")).ino, inode);
  assert.equal(existsSync(other), false);
});

test("a branch switch removes a recorded root that holds a tracked path", async (t) => {
  const h = await restartFixture(t);
  const first = await h.prepare(FIRST_ATTEMPT);
  const deps = join(first.directory, "deps");
  mkdirSync(deps);
  await commit(first.directory, "deps/tracked", "tracked");
  writeFileSync(join(deps, "untracked"), "x");
  writeSetupRecordOf(first.directory, ["deps/"]);
  await h.prepare(RESTART_ATTEMPT);
  assert.equal(existsSync(deps), false);
});

const BINDING_NAMES = ["api", "web"];

async function bindingsFixture(t: test.TestContext, names = BINDING_NAMES) {
  const workspace = WorkspaceRoot.open(temporary(t));
  const nodeId = createIdentity("node");
  const repositories: ImplementInput["repositories"][number][] = [];
  let base = "";
  for (const name of names) {
    const { root, built } = await restartTemplate(t);
    base = built;
    repositories.push({
      binding_id: createIdentity("binding"),
      name,
      address: join(root, ORIGIN_NAME),
      strategy: { base_branch: "main" },
    });
  }
  const nodeBranch = nodeBranchOf(nodeId, FIRST_ATTEMPT);
  const prepare = (pushed: ReadonlySet<string> = new Set()) =>
    workspace.prepareImplement({
      env,
      transport,
      sshAccess: everyBindingSshAccess,
      context: background,
      deadlineMs: GIT_DEADLINE_MS,
      nodeId,
      nodeBranch,
      pushed,
      repositories,
    });
  return { workspace, nodeId, nodeBranch, repositories, base, prepare };
}

test("two bindings prepare two checkouts under checkouts/ with one hold", async (t) => {
  const h = await bindingsFixture(t);
  const key = h.workspace.nodeKey(h.nodeId);
  const prepared = await h.prepare();
  assert.equal(prepared.root, join(key, CHECKOUTS_DIRECTORY));
  assert.deepEqual(
    prepared.checkouts,
    h.repositories.map((repository) => ({
      binding_id: repository.binding_id,
      name: repository.name,
      directory: join(key, CHECKOUTS_DIRECTORY, repository.name),
      head: h.base,
    })),
  );
  for (const checkout of prepared.checkouts)
    assert.equal(
      (await simpleGit(checkout.directory).branch()).current,
      h.nodeBranch,
    );
  assert.throws(() => h.workspace.hold(key));
  h.workspace.release(key, WorkspaceKind.Node);
  h.workspace.hold(key);
  h.workspace.release(key, WorkspaceKind.Node);
});

test("one binding uses the checkout as the agent root", async (t) => {
  const h = await bindingsFixture(t, ["api"]);
  const prepared = await h.prepare();
  assert.equal(
    prepared.root,
    join(h.workspace.nodeKey(h.nodeId), CHECKOUTS_DIRECTORY, "api"),
  );
  assert.equal(prepared.root, prepared.checkouts[0]!.directory);
  h.workspace.release(h.workspace.nodeKey(h.nodeId), WorkspaceKind.Node);
});

test("the scratch directory is excluded in each checkout", async (t) => {
  const h = await bindingsFixture(t);
  const prepared = await h.prepare();
  for (const checkout of prepared.checkouts)
    assert.ok(
      readFileSync(join(checkout.directory, ".git", "info", "exclude"), "utf8")
        .split("\n")
        .includes(SCRATCH_DIRECTORY),
    );
  h.workspace.release(h.workspace.nodeKey(h.nodeId), WorkspaceKind.Node);
});

test("a missing remote node branch in one checkout stops with repository.node_branch.missing", async (t) => {
  const h = await bindingsFixture(t);
  const key = h.workspace.nodeKey(h.nodeId);
  const prepared = await h.prepare();
  for (const checkout of prepared.checkouts)
    await connector.pushNodeBranch(
      checkout.directory,
      h.nodeBranch,
      background,
      10000,
      LOCAL_GIT_SSH_ACCESS,
    );
  h.workspace.release(key, WorkspaceKind.Node);
  await simpleGit(h.repositories[1]!.address).raw([
    "branch",
    "-D",
    h.nodeBranch,
  ]);
  await assert.rejects(h.prepare(), missing);
  for (const checkout of prepared.checkouts)
    assert.ok(existsSync(join(checkout.directory, ".git")));
  const fresh = await bindingsFixture(t);
  await assert.rejects(
    fresh.prepare(new Set([fresh.repositories[1]!.binding_id])),
    missing,
  );
  h.workspace.hold(key);
  h.workspace.release(key, WorkspaceKind.Node);
});

test("a handed SSH access takes the port of the address host from the fixed table", () => {
  const ports = {
    "git@github.com:owner/repo.git": 22,
    "git@ssh.github.com:owner/repo.git": 443,
    "git@altssh.gitlab.com:owner/repo.git": 443,
    "git@altssh.bitbucket.org:owner/repo.git": 443,
  };
  const repositories = Object.keys(ports).map((address) => ({
    ...repositorySetup(),
    address,
  }));
  const { private_key } = generateSshKey("handed");
  const access = handedSshAccess(
    repositories.map(({ binding_id }) => ({
      binding_id,
      credential_id: createIdentity("credential"),
      private_key,
    })),
    repositories,
  );
  assert.deepEqual(
    repositories.map(({ binding_id }) => access.get(binding_id)?.port),
    Object.values(ports),
  );
});

test("a repository binding without a handed SSH identity takes the relay with the setup public key", () => {
  const [handed, relayed] = [repositorySetup(), repositorySetup()];
  const { private_key } = generateSshKey("handed");
  const signer = async () => Buffer.alloc(0);
  const bindings: string[] = [];
  const access = handedSshAccess(
    [
      {
        binding_id: handed.binding_id,
        credential_id: createIdentity("credential"),
        private_key,
      },
    ],
    [handed, relayed],
    (bindingId) => {
      bindings.push(bindingId);
      return signer;
    },
  );
  const keyAccess = access.get(handed.binding_id);
  assert.ok(keyAccess && "private_key" in keyAccess);
  assert.equal(keyAccess.private_key, private_key);
  const relayAccess = access.get(relayed.binding_id);
  assert.ok(relayAccess && "relay" in relayAccess);
  assert.equal(relayAccess.relay, signer);
  assert.equal(relayAccess.public_key, relayed.ssh_public_key);
  assert.equal(relayAccess.known_hosts, relayed.ssh_host_key.known_hosts);
  assert.equal(relayAccess.port, DEFAULT_SSH_PORT);
  assert.deepEqual(bindings, [relayed.binding_id]);
  assert.throws(() => handedSshAccess([], [relayed]));
});

const ONE_TREE = 1;
const NEXT_FILE = "next";

async function reviewFixture(t: test.TestContext) {
  const h = await restartFixture(t);
  const workspace = WorkspaceRoot.open(dirname(h.origin));
  const repository = {
    binding_id: createIdentity("binding"),
    name: "todoapp-repo",
    address: h.origin,
    strategy: { base_branch: "main" },
  };
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  const review = (nodeId: string, commit: string) =>
    workspace.prepareSnapshots({
      env,
      transport,
      sshAccess: everyBindingSshAccess,
      context: background,
      deadlineMs: GIT_DEADLINE_MS,
      executionId: createIdentity("execution"),
      nodeId,
      log: (msg, fields) => logs.push({ msg, fields }),
      snapshots: [{ repository, commit }],
    });
  const push = async (file: string, value: string) => {
    const pushed = await commit(h.seed, file, value);
    await h.git.push("origin", "main");
    return pushed;
  };
  const reviewKey = (nodeId: string) =>
    join(workspace.nodeKey(nodeId), "review");
  const freeTrees = (poolClass: PoolClass) =>
    workspace.pool
      .trees()
      .filter((tree) => basename(dirname(tree.path)) === poolClass);
  return {
    ...h,
    workspace,
    repository,
    logs,
    review,
    push,
    reviewKey,
    freeTrees,
  };
}

test("a second review of the same repository reuses the tree and keeps each file of a setup root", async (t) => {
  const h = await reviewFixture(t);
  const first = await h.review(createIdentity("node"), h.base);
  assert.equal(first.kind, WorkspaceKind.Review);
  mkdirSync(join(first.directory, "deps"));
  writeFileSync(join(first.directory, "deps", "marker"), "x");
  writeFileSync(join(first.directory, "stray"), "x");
  writeSetupRecordOf(first.directory, ["deps/"]);
  const before = statSync(join(first.directory, "deps", "marker"));
  const tree = statSync(join(first.directory, ".git")).ino;
  h.workspace.release(first.key, first.kind);
  const next = await h.push(NEXT_FILE, NEXT_FILE);
  const second = await h.review(createIdentity("node"), next);
  assert.deepEqual(second.tested_input, {
    kind: "repository",
    binding_id: h.repository.binding_id,
    commit: next,
  });
  assert.equal(statSync(join(second.directory, ".git")).ino, tree);
  const after = statSync(join(second.directory, "deps", "marker"));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(existsSync(join(second.directory, "stray")), false);
  assert.equal(
    readFileSync(join(second.directory, NEXT_FILE), "utf8"),
    NEXT_FILE,
  );
  assert.deepEqual(
    h.logs.map(({ msg, fields }) => [msg, fields.purpose, fields.source]),
    [
      ["tree prepared", "review", "clone"],
      ["tree prepared", "review", "pool"],
    ],
  );
  h.workspace.release(second.key, second.kind);
});

test("a review release gives the trees back, removes the evidence and keeps the node key", async (t) => {
  const h = await reviewFixture(t);
  const nodeId = createIdentity("node");
  const prepared = await h.review(nodeId, h.base);
  assert.equal(prepared.key, h.reviewKey(nodeId));
  const evidence = join(prepared.key, "evidence");
  mkdirSync(evidence);
  writeFileSync(join(evidence, "report.md"), "x");
  const base = join(prepared.key, "base", h.repository.name);
  await simpleGit().raw(["clone", "--", prepared.directory, base]);
  h.workspace.release(prepared.key, prepared.kind);
  assert.equal(h.freeTrees(PoolClass.Agent).length, ONE_TREE);
  assert.equal(h.freeTrees(PoolClass.Command).length, ONE_TREE);
  assert.equal(existsSync(evidence), false);
  assert.equal(existsSync(prepared.directory), false);
  assert.equal(existsSync(base), false);
  assert.equal(existsSync(h.workspace.nodeKey(nodeId)), true);
  h.workspace.hold(h.workspace.nodeKey(nodeId));
  h.workspace.release(h.workspace.nodeKey(nodeId), WorkspaceKind.Node);
});

test("a review preparation removes residue at the top of the review directory", async (t) => {
  const h = await reviewFixture(t);
  const nodeId = createIdentity("node");
  const key = h.reviewKey(nodeId);
  const leftover = join(key, CHECKOUTS_DIRECTORY, h.repository.name);
  mkdirSync(join(key, CHECKOUTS_DIRECTORY), { recursive: true });
  await simpleGit().raw(["clone", "--", h.origin, leftover]);
  const tree = statSync(join(leftover, ".git")).ino;
  const residue = [
    join(key, "stray", "file"),
    join(key, "evidence", "old.md"),
    join(key, CHECKOUTS_DIRECTORY, "unbound", "file"),
    join(key, "base", h.repository.name, "file"),
  ];
  for (const path of residue) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x");
  }
  const prepared = await h.review(nodeId, h.base);
  assert.equal(prepared.directory, leftover);
  assert.equal(statSync(join(leftover, ".git")).ino, tree);
  for (const path of residue) assert.equal(existsSync(path), false);
  assert.deepEqual(readdirSync(key).sort(), [CHECKOUTS_DIRECTORY]);
  h.workspace.release(prepared.key, prepared.kind);
});
