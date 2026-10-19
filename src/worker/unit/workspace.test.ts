import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import * as connector from "../../repository/connector.ts";
import { fixtureTemplate, temporary } from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { nodeBranchOf } from "../../repository/node-branch.ts";
import { generateSshKey } from "../../repository/ssh-key.ts";
import {
  CHECKOUTS_DIRECTORY,
  handedSshAccess,
  SCRATCH_DIRECTORY,
  WorkspaceKind,
  WorkspaceRoot,
  WORKSPACE_RETENTION_MS,
} from "./workspace.ts";
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

test("workspace retention respects holds and release kind", (t) => {
  const workspace = WorkspaceRoot.open(temporary(t));
  const old = workspace.nodeKey(createIdentity("node"));
  const recent = workspace.nodeKey(createIdentity("node"));
  const held = workspace.nodeKey(createIdentity("node"));
  const execution = workspace.executionKey(createIdentity("execution"));
  const now = Date.now();
  for (const key of [old, recent, held, execution])
    mkdirSync(key, { mode: 0o700 });
  const expired = new Date(now - WORKSPACE_RETENTION_MS - 86400000);
  for (const key of [old, held]) utimesSync(key, expired, expired);
  workspace.hold(held);
  assert.throws(() => workspace.hold(held));
  workspace.sweep(now);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(held), true);
  workspace.release(held, WorkspaceKind.Node);
  assert.ok(statSync(held).mtimeMs > now - WORKSPACE_RETENTION_MS);
  workspace.hold(execution);
  workspace.release(execution, WorkspaceKind.Execution);
  assert.equal(existsSync(execution), false);
  workspace.startSweeping();
  workspace.stopSweeping();
});

test("workspace preparation refreshes implement branches and creates disposable snapshots and examine workspaces", async (t) => {
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
    transport,
    sshAccess: everyBindingSshAccess,
    context: background,
    deadlineMs: 10000,
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
  workspace.release(snapshot.key, WorkspaceKind.Execution);
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
        repositories: [repository, another],
      });
      assert.deepEqual(
        examine.tested_input,
        [repository, another].map(({ binding_id }) => ({
          kind: "repository",
          binding_id: binding_id,
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
      workspace.release(examine.key, WorkspaceKind.Execution);
      assert.equal(existsSync(examine.key), false);
    },
  );
  await t.test(
    "an examine node with one binding uses the checkout as the agent root",
    async () => {
      const examine = await workspace.prepareExamine({
        ...common,
        executionId: createIdentity("execution"),
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
      workspace.release(examine.key, WorkspaceKind.Execution);
    },
  );
  const empty = await workspace.prepareExamine({
    ...common,
    executionId: createIdentity("execution"),
    repositories: [],
  });
  assert.equal(empty.tested_input, null);
  assert.equal(empty.directory, empty.key);
  workspace.release(empty.key, WorkspaceKind.Execution);
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
      deadlineMs: 10000,
    };
    return [
      prepareOne(workspace, {
        ...common,
        nodeId: createIdentity("node"),
        nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
        pushed: false,
        repository,
      }),
      workspace.prepareSnapshots({
        ...common,
        executionId: createIdentity("execution"),
        snapshots: [{ repository, commit: "head" }],
      }),
      workspace.prepareExamine({
        ...common,
        executionId: createIdentity("execution"),
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
    transport,
    sshAccess: everyBindingSshAccess,
    context: background,
    deadlineMs: 10000,
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
      transport,
      sshAccess: everyBindingSshAccess,
      context: background,
      deadlineMs: 10000,
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
      transport,
      sshAccess: everyBindingSshAccess,
      context: background,
      deadlineMs: 10000,
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
