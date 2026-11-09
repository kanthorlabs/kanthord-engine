import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
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
import { branchKeyOf, readPushRecord, writePushRecord } from "./push-record.ts";
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
  const key = workspace.nodeKey(nodeId);
  let held = false;
  const prepare = async (startAttempt: number, pushed = false) => {
    if (held) workspace.release(key, WorkspaceKind.Node);
    held = false;
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
    held = true;
    return prepared;
  };
  const push = async (prepared: { directory: string; nodeBranch: string }) => {
    const record = {
      nodeKey: key,
      nodeBranch: prepared.nodeBranch,
      bindingId: repository.binding_id,
    };
    const head = (
      await simpleGit(prepared.directory).revparse(["HEAD"])
    ).trim();
    writePushRecord(record, {
      confirmed: readPushRecord(record)?.confirmed ?? null,
      pending: head,
    });
    await connector.pushNodeBranch(
      prepared.directory,
      prepared.nodeBranch,
      background,
      GIT_DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    );
    writePushRecord(record, { confirmed: head, pending: null });
  };
  const remoteHead = async (branch: string) =>
    (await simpleGit(origin).revparse([`refs/heads/${branch}`])).trim();
  const deleteRemote = (branch: string) =>
    simpleGit(origin).raw(["branch", "-D", branch]);
  return {
    origin,
    seed,
    base,
    commit,
    prepare,
    push,
    remoteHead,
    deleteRemote,
    git,
  };
}

const missing = { code: connector.NODE_BRANCH_MISSING };

test("a continued attempt whose pushed node branch is gone stops and keeps its checkout", async (t) => {
  const h = await restartFixture(t);
  const first = await h.prepare(FIRST_ATTEMPT);
  const pushed = await h.commit(first.directory, "work", "pushed");
  await h.push(first);
  await h.deleteRemote(first.nodeBranch);
  await assert.rejects(h.prepare(FIRST_ATTEMPT), missing);
  await assert.rejects(h.prepare(FIRST_ATTEMPT), missing);
  assert.equal(
    (await simpleGit(first.directory).revparse(["HEAD"])).trim(),
    pushed,
  );
  await h.push(first);
  assert.equal((await h.prepare(FIRST_ATTEMPT)).head, pushed);
});

test("a restart from the base branch checks out the base, pushes a new node branch and leaves the earlier branch", async (t) => {
  const h = await restartFixture(t);
  const first = await h.prepare(FIRST_ATTEMPT);
  assert.equal(first.head, h.base);
  const earlier = await h.commit(first.directory, "work", "rejected");
  await h.push(first);
  const restart = await h.prepare(RESTART_ATTEMPT);
  assert.equal(restart.directory, first.directory);
  assert.equal(restart.nodeBranch, `${first.nodeBranch}-a2`);
  assert.equal(restart.head, h.base);
  const fresh = await h.commit(restart.directory, "work", "fresh");
  await h.push(restart);
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
  await h.push(first);
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
  const prepare = (
    pushed: ReadonlySet<string> = new Set(),
    branch = nodeBranch,
  ) =>
    workspace.prepareImplement({
      env,
      transport,
      sshAccess: everyBindingSshAccess,
      context: background,
      deadlineMs: GIT_DEADLINE_MS,
      nodeId,
      nodeBranch: branch,
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

test("a missing remote node branch in one checkout stops with repository.node_branch.missing", async (t) => {
  const h = await bindingsFixture(t);
  const key = h.workspace.nodeKey(h.nodeId);
  const prepared = await h.prepare();
  for (const checkout of prepared.checkouts) {
    await connector.pushNodeBranch(
      checkout.directory,
      h.nodeBranch,
      background,
      10000,
      LOCAL_GIT_SSH_ACCESS,
    );
    writePushRecord(
      {
        nodeKey: key,
        nodeBranch: h.nodeBranch,
        bindingId: checkout.binding_id,
      },
      { confirmed: checkout.head, pending: null },
    );
  }
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
const TRUNK_BRANCH = "trunk";
const DETACHED_HEAD = "HEAD";

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

test("a review release gives the checkout back, deletes the base head and the evidence and keeps the node key", async (t) => {
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
  assert.deepEqual(h.freeTrees(PoolClass.Command), []);
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

test("a reused review tree holds the local default branch and the current origin/HEAD, as a fresh clone does", async (t) => {
  const h = await reviewFixture(t);
  await simpleGit(h.origin).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  const first = await h.review(createIdentity("node"), h.base);
  h.workspace.release(first.key, first.kind);
  await h.git.raw(["checkout", "-b", TRUNK_BRANCH]);
  const trunk = await commit(h.seed, TRUNK_BRANCH, TRUNK_BRANCH);
  await h.git.push("origin", TRUNK_BRANCH);
  await simpleGit(h.origin).raw([
    "symbolic-ref",
    "HEAD",
    `refs/heads/${TRUNK_BRANCH}`,
  ]);
  const second = await h.review(createIdentity("node"), h.base);
  assert.deepEqual(
    h.logs.map(({ fields }) => fields.source),
    ["clone", "pool"],
  );
  const fresh = join(temporary(t), "fresh");
  await simpleGit().raw(["clone", "--no-checkout", "--", h.origin, fresh]);
  const refsOf = async (directory: string) => ({
    heads: (
      await simpleGit(directory).raw([
        "for-each-ref",
        "--format=%(refname) %(objectname) %(upstream)",
        "refs/heads",
      ])
    ).trim(),
    origin: (
      await simpleGit(directory).raw([
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
      ])
    ).trim(),
  });
  assert.deepEqual(await refsOf(second.directory), await refsOf(fresh));
  assert.deepEqual(await refsOf(second.directory), {
    heads: `refs/heads/${TRUNK_BRANCH} ${trunk} refs/remotes/origin/${TRUNK_BRANCH}`,
    origin: `refs/remotes/origin/${TRUNK_BRANCH}`,
  });
  assert.equal(
    (await simpleGit(second.directory).revparse(["HEAD"])).trim(),
    h.base,
  );
  assert.equal(
    (
      await simpleGit(second.directory).revparse(["--abbrev-ref", "HEAD"])
    ).trim(),
    DETACHED_HEAD,
  );
  h.workspace.release(second.key, second.kind);
});

async function outsideTree(t: test.TestContext, origin: string, name: string) {
  const outside = temporary(t);
  await simpleGit().raw(["clone", "--", origin, join(outside, name)]);
  chmodSync(join(outside, name, ".git"), 0o755);
  return outside;
}

test("a review release does not follow a symbolic link that replaces review/checkouts", async (t) => {
  const h = await reviewFixture(t);
  const prepared = await h.review(createIdentity("node"), h.base);
  const outside = await outsideTree(t, h.origin, h.repository.name);
  const checkouts = join(prepared.key, CHECKOUTS_DIRECTORY);
  rmSync(checkouts, { recursive: true, force: true });
  symlinkSync(outside, checkouts);
  h.workspace.release(prepared.key, prepared.kind);
  assert.equal(existsSync(join(outside, h.repository.name, ".git")), true);
  assert.equal(existsSync(prepared.key), false);
  assert.deepEqual(h.workspace.pool.trees(), []);
});

test("a node preparation does not follow a symbolic link that replaces the release directory", async (t) => {
  const h = await reviewFixture(t);
  const nodeId = createIdentity("node");
  const outside = await outsideTree(t, h.origin, h.repository.name);
  writeFileSync(join(outside, "stray"), "x");
  mkdirSync(h.workspace.nodeKey(nodeId), { mode: 0o700 });
  symlinkSync(outside, join(h.workspace.nodeKey(nodeId), "release"));
  await prepareOne(h.workspace, {
    env,
    transport,
    sshAccess: everyBindingSshAccess,
    context: background,
    deadlineMs: GIT_DEADLINE_MS,
    nodeId,
    nodeBranch: nodeBranchOf(nodeId, FIRST_ATTEMPT),
    pushed: false,
    repository: h.repository,
  });
  h.workspace.release(h.workspace.nodeKey(nodeId), WorkspaceKind.Node);
  assert.equal(existsSync(join(outside, h.repository.name, ".git")), true);
  assert.equal(existsSync(join(outside, "stray")), true);
  assert.equal(existsSync(join(h.workspace.nodeKey(nodeId), "release")), false);
  assert.deepEqual(h.freeTrees(PoolClass.Command), []);
});

async function coderFixture(t: test.TestContext) {
  const h = await restartFixture(t);
  const workspace = WorkspaceRoot.open(dirname(h.origin));
  const repository = {
    binding_id: createIdentity("binding"),
    name: "todoapp-repo",
    address: h.origin,
    strategy: { base_branch: "main" },
  };
  const logs: { msg: string; fields: Record<string, unknown> }[] = [];
  const prepare = (nodeId: string, attempt = FIRST_ATTEMPT) =>
    prepareOne(workspace, {
      env,
      transport,
      sshAccess: everyBindingSshAccess,
      context: background,
      deadlineMs: GIT_DEADLINE_MS,
      nodeId,
      nodeBranch: nodeBranchOf(nodeId, attempt),
      pushed: false,
      repository,
      log: (msg, fields) => logs.push({ msg, fields }),
    });
  const release = (nodeId: string) =>
    workspace.release(workspace.nodeKey(nodeId), WorkspaceKind.Node);
  const freeTrees = (poolClass: PoolClass) =>
    workspace.pool
      .trees()
      .filter((tree) => basename(dirname(tree.path)) === poolClass);
  const recordKey = (nodeId: string, nodeBranch: string) => ({
    nodeKey: workspace.nodeKey(nodeId),
    nodeBranch,
    bindingId: repository.binding_id,
  });
  const pushNode = async (
    nodeId: string,
    prepared: { directory: string; nodeBranch: string },
  ) => {
    await connector.pushNodeBranch(
      prepared.directory,
      prepared.nodeBranch,
      background,
      GIT_DEADLINE_MS,
      LOCAL_GIT_SSH_ACCESS,
    );
    const head = (
      await simpleGit(prepared.directory).revparse(["HEAD"])
    ).trim();
    writePushRecord(recordKey(nodeId, prepared.nodeBranch), {
      confirmed: head,
      pending: null,
    });
    return head;
  };
  const sources = () =>
    logs
      .filter(({ msg }) => msg === TREE_PREPARED)
      .map(({ fields }) => [fields.purpose, fields.source]);
  return {
    ...h,
    workspace,
    repository,
    logs,
    prepare,
    release,
    freeTrees,
    sources,
    recordKey,
    pushNode,
  };
}

const SCRATCH_PROBE = "probe.mjs";
const ROOT_USER = 0;
const PENDING_REBUILD = { code: "repository.node_checkout.pending_rebuild" };
const SCRATCH_TEXT = "x";
const TREE_PREPARED = "tree prepared";
const OUTSIDE_TEXT = "outside";

function writeScratch(root: string): string {
  const probe = join(root, SCRATCH_DIRECTORY, SCRATCH_PROBE);
  mkdirSync(dirname(probe), { recursive: true });
  writeFileSync(probe, SCRATCH_TEXT);
  return probe;
}

test("a second node of the same repository takes the coder tree and keeps each file of a setup root", async (t) => {
  const h = await coderFixture(t);
  const firstNode = createIdentity("node");
  const first = await h.prepare(firstNode);
  mkdirSync(join(first.directory, "deps"));
  writeFileSync(join(first.directory, "deps", "marker"), "x");
  writeFileSync(join(first.directory, "stray"), "x");
  writeFileSync(join(first.directory, "ignored.txt"), "x");
  writeSetupRecordOf(first.directory, ["deps/"]);
  const marker = statSync(join(first.directory, "deps", "marker"));
  const tree = statSync(join(first.directory, ".git")).ino;
  h.release(firstNode);
  assert.equal(existsSync(first.directory), false);
  assert.equal(existsSync(h.workspace.nodeKey(firstNode)), true);
  assert.equal(h.freeTrees(PoolClass.Agent).length, ONE_TREE);
  const secondNode = createIdentity("node");
  const second = await h.prepare(secondNode);
  assert.equal(statSync(join(second.directory, ".git")).ino, tree);
  const after = statSync(join(second.directory, "deps", "marker"));
  assert.equal(after.ino, marker.ino);
  assert.equal(after.mtimeMs, marker.mtimeMs);
  for (const residue of ["stray", "ignored.txt"])
    assert.equal(existsSync(join(second.directory, residue)), false);
  assert.equal(second.head, h.base);
  assert.equal(
    (await simpleGit(second.directory).branch()).current,
    second.nodeBranch,
  );
  assert.equal(
    (
      await simpleGit(second.directory).raw([
        "config",
        "--get",
        "remote.origin.url",
      ])
    ).trim(),
    h.origin,
  );
  assert.deepEqual(h.sources(), [
    ["coder", "clone"],
    ["coder", "pool"],
  ]);
  h.release(secondNode);
});

test("a pool tree with a stale remote-tracking ref of the node branch starts from the base as a fresh clone does", async (t) => {
  const h = await coderFixture(t);
  const nodeId = createIdentity("node");
  const first = await h.prepare(nodeId);
  await h.commit(first.directory, "work", "pushed");
  await connector.pushNodeBranch(
    first.directory,
    first.nodeBranch,
    background,
    GIT_DEADLINE_MS,
    LOCAL_GIT_SSH_ACCESS,
  );
  h.release(nodeId);
  await h.deleteRemote(first.nodeBranch);
  const again = await h.prepare(nodeId);
  assert.equal(again.head, h.base);
  assert.deepEqual(h.sources(), [
    ["coder", "clone"],
    ["coder", "pool"],
  ]);
  h.release(nodeId);
});

test("a node keeps its scratch across executions of one attempt", async (t) => {
  const h = await coderFixture(t);
  const nodeId = createIdentity("node");
  const first = await h.prepare(nodeId);
  await h.pushNode(nodeId, first);
  writeScratch(first.directory);
  writeFileSync(join(first.directory, "ignored.txt"), "x");
  h.release(nodeId);
  assert.equal(existsSync(first.directory), false);
  const second = await h.prepare(nodeId);
  assert.equal(
    readFileSync(
      join(second.directory, SCRATCH_DIRECTORY, SCRATCH_PROBE),
      "utf8",
    ),
    SCRATCH_TEXT,
  );
  assert.equal(existsSync(join(second.directory, "ignored.txt")), true);
  assert.equal(existsSync(join(h.workspace.nodeKey(nodeId), "scratch")), false);
  h.release(nodeId);
  await t.test("two bindings keep checkouts/.kanthord-scratch", async () => {
    const b = await bindingsFixture(t);
    const key = b.workspace.nodeKey(b.nodeId);
    const prepared = await b.prepare();
    const probe = writeScratch(prepared.root);
    b.workspace.release(key, WorkspaceKind.Node);
    await b.prepare();
    assert.equal(readFileSync(probe, "utf8"), SCRATCH_TEXT);
    b.workspace.release(key, WorkspaceKind.Node);
  });
});

test("a restart attempt gets no scratch of the earlier attempt", async (t) => {
  const h = await coderFixture(t);
  const nodeId = createIdentity("node");
  const first = await h.prepare(nodeId);
  writeScratch(first.directory);
  h.release(nodeId);
  const restart = await h.prepare(nodeId, RESTART_ATTEMPT);
  assert.equal(existsSync(join(restart.directory, SCRATCH_DIRECTORY)), false);
  assert.equal(existsSync(join(h.workspace.nodeKey(nodeId), "scratch")), false);
  h.release(nodeId);
  await t.test("two bindings", async () => {
    const b = await bindingsFixture(t);
    const key = b.workspace.nodeKey(b.nodeId);
    const prepared = await b.prepare();
    const probe = writeScratch(prepared.root);
    b.workspace.release(key, WorkspaceKind.Node);
    await b.prepare(new Set(), nodeBranchOf(b.nodeId, RESTART_ATTEMPT));
    assert.equal(existsSync(probe), false);
    b.workspace.release(key, WorkspaceKind.Node);
  });
});

test("a coder tree with a pending push stays in the node key", async (t) => {
  const h = await coderFixture(t);
  const nodeId = createIdentity("node");
  const first = await h.prepare(nodeId);
  const pending = await h.commit(first.directory, "work", "unpushed");
  writePushRecord(
    {
      nodeKey: h.workspace.nodeKey(nodeId),
      nodeBranch: first.nodeBranch,
      bindingId: h.repository.binding_id,
    },
    { confirmed: null, pending },
  );
  writeFileSync(join(first.directory, "ignored.txt"), "x");
  h.release(nodeId);
  assert.ok(existsSync(join(first.directory, ".git")));
  assert.deepEqual(h.freeTrees(PoolClass.Agent), []);
  const again = await h.prepare(nodeId);
  assert.equal(again.directory, first.directory);
  assert.equal(again.head, pending);
  assert.equal(existsSync(join(again.directory, "ignored.txt")), true);
  assert.deepEqual(h.sources(), [
    ["coder", "clone"],
    ["coder", "node"],
  ]);
  h.release(nodeId);
});

test("a node release does not follow a symbolic link that replaces the scratch directory or the checkouts directory", async (t) => {
  const h = await coderFixture(t);
  const nodeId = createIdentity("node");
  const outside = temporary(t);
  writeFileSync(join(outside, SCRATCH_PROBE), OUTSIDE_TEXT);
  const first = await h.prepare(nodeId);
  symlinkSync(outside, join(first.directory, ".kanthord-scratch"));
  h.release(nodeId);
  assert.equal(
    readFileSync(join(outside, SCRATCH_PROBE), "utf8"),
    OUTSIDE_TEXT,
  );
  assert.equal(h.freeTrees(PoolClass.Agent).length, ONE_TREE);
  const second = await h.prepare(nodeId);
  assert.equal(existsSync(join(second.directory, ".kanthord-scratch")), false);
  const tree = await outsideTree(t, h.origin, h.repository.name);
  const outsideScratch = writeScratch(join(tree, h.repository.name));
  const checkouts = join(h.workspace.nodeKey(nodeId), CHECKOUTS_DIRECTORY);
  rmSync(checkouts, { recursive: true, force: true });
  symlinkSync(tree, checkouts);
  h.release(nodeId);
  assert.ok(existsSync(join(tree, h.repository.name, ".git")));
  assert.equal(readFileSync(outsideScratch, "utf8"), SCRATCH_TEXT);
  assert.equal(existsSync(checkouts), false);
  assert.equal(
    readFileSync(join(outside, SCRATCH_PROBE), "utf8"),
    OUTSIDE_TEXT,
  );
});

test("a broken or linked push record refuses the preparation and is not followed", async (t) => {
  const h = await coderFixture(t);
  const nodeId = createIdentity("node");
  const first = await h.prepare(nodeId);
  const pushed = await h.commit(first.directory, "work", "pushed");
  await connector.pushNodeBranch(
    first.directory,
    first.nodeBranch,
    background,
    GIT_DEADLINE_MS,
    LOCAL_GIT_SSH_ACCESS,
  );
  const key = {
    nodeKey: h.workspace.nodeKey(nodeId),
    nodeBranch: first.nodeBranch,
    bindingId: h.repository.binding_id,
  };
  writePushRecord(key, { confirmed: pushed, pending: null });
  h.release(nodeId);
  const record = join(
    key.nodeKey,
    "pushed",
    branchKeyOf(first.nodeBranch),
    h.repository.binding_id,
  );
  const outside = join(temporary(t), "record");
  writeFileSync(outside, OUTSIDE_TEXT);
  for (const broken of [
    () => writeFileSync(record, "{"),
    () =>
      writeFileSync(record, JSON.stringify({ confirmed: "x", pending: null })),
    () => {
      rmSync(record);
      symlinkSync(outside, record);
    },
  ]) {
    broken();
    assert.equal(readPushRecord(key), null);
    await assert.rejects(h.prepare(nodeId), PENDING_REBUILD);
    assert.equal(readPushRecord(key), null);
  }
  assert.equal(h.freeTrees(PoolClass.Agent).length, ONE_TREE);
  assert.equal(readFileSync(outside, "utf8"), OUTSIDE_TEXT);
});

const BROKEN_RECORD = "{";

test("an unreadable push record keeps the tree under the node key and refuses the next preparation", async (t) => {
  const h = await coderFixture(t);
  const nodeId = createIdentity("node");
  const first = await h.prepare(nodeId);
  await h.commit(first.directory, "work", "pushed");
  await h.pushNode(nodeId, first);
  const local = await h.commit(first.directory, "work", "local");
  const key = h.recordKey(nodeId, first.nodeBranch);
  const record = join(
    key.nodeKey,
    "pushed",
    branchKeyOf(first.nodeBranch),
    key.bindingId,
  );
  writeFileSync(record, BROKEN_RECORD);
  h.release(nodeId);
  assert.ok(existsSync(join(first.directory, ".git")));
  assert.deepEqual(h.freeTrees(PoolClass.Agent), []);
  await assert.rejects(h.prepare(nodeId), PENDING_REBUILD);
  assert.equal(
    (
      await simpleGit(first.directory).revparse([
        `refs/heads/${first.nodeBranch}`,
      ])
    ).trim(),
    local,
  );
  assert.equal(
    (await simpleGit(first.directory).revparse(["HEAD"])).trim(),
    local,
  );
  assert.equal(readFileSync(record, "utf8"), BROKEN_RECORD);
});

test("a node preparation removes each checkout of a removed binding and does not follow a symbolic link", async (t) => {
  const h = await coderFixture(t);
  const nodeId = createIdentity("node");
  const checkouts = join(h.workspace.nodeKey(nodeId), CHECKOUTS_DIRECTORY);
  const removed = join(checkouts, "removed-repo");
  mkdirSync(checkouts, { recursive: true, mode: 0o700 });
  await simpleGit().raw(["clone", "--", h.origin, removed]);
  const outside = temporary(t);
  writeFileSync(join(outside, SCRATCH_PROBE), OUTSIDE_TEXT);
  symlinkSync(outside, join(checkouts, "linked"));
  const scratch = writeScratch(checkouts);
  const prepared = await h.prepare(nodeId);
  assert.deepEqual(readdirSync(checkouts).sort(), [
    ".kanthord-scratch",
    h.repository.name,
  ]);
  assert.equal(readFileSync(scratch, "utf8"), SCRATCH_TEXT);
  assert.equal(
    readFileSync(join(outside, SCRATCH_PROBE), "utf8"),
    OUTSIDE_TEXT,
  );
  assert.ok(existsSync(join(prepared.directory, ".git")));
  h.release(nodeId);
});

async function refsOf(directory: string, exclude: string) {
  const heads = (
    await simpleGit(directory).raw([
      "for-each-ref",
      "--format=%(refname) %(objectname) %(upstream)",
      "refs/heads",
    ])
  )
    .trim()
    .split("\n")
    .filter((line) => !line.startsWith(`refs/heads/${exclude} `));
  const origin = (
    await simpleGit(directory).raw(["symbolic-ref", "refs/remotes/origin/HEAD"])
  ).trim();
  return { heads, origin };
}

test("a pool tree with a commit after the confirmed push starts at the same head and default branch as a fresh clone", async (t) => {
  const h = await coderFixture(t);
  await simpleGit(h.origin).raw(["symbolic-ref", "HEAD", "refs/heads/main"]);
  const nodeId = createIdentity("node");
  const first = await h.prepare(nodeId);
  await h.commit(first.directory, "work", "pushed");
  const confirmed = await h.pushNode(nodeId, first);
  await h.commit(first.directory, "work", "after");
  h.release(nodeId);
  await h.git.raw(["checkout", "-b", TRUNK_BRANCH]);
  await commit(h.seed, TRUNK_BRANCH, TRUNK_BRANCH);
  await h.git.push("origin", TRUNK_BRANCH);
  await simpleGit(h.origin).raw([
    "symbolic-ref",
    "HEAD",
    `refs/heads/${TRUNK_BRANCH}`,
  ]);
  const again = await h.prepare(nodeId);
  assert.deepEqual(h.sources(), [
    ["coder", "clone"],
    ["coder", "pool"],
  ]);
  assert.equal(again.head, confirmed);
  const fresh = join(temporary(t), "fresh");
  await simpleGit().raw(["clone", "--no-checkout", "--", h.origin, fresh]);
  assert.deepEqual(
    await refsOf(again.directory, again.nodeBranch),
    await refsOf(fresh, again.nodeBranch),
  );
  h.release(nodeId);
});

test("a node-key tree with a pending push that answers rebuild stays and the preparation refuses", async (t) => {
  const h = await coderFixture(t);
  const nodeId = createIdentity("node");
  const first = await h.prepare(nodeId);
  const pending = await h.commit(first.directory, "work", "unpushed");
  writePushRecord(h.recordKey(nodeId, first.nodeBranch), {
    confirmed: null,
    pending,
  });
  const linked = join(temporary(t), "linked");
  await simpleGit(first.directory).raw(["worktree", "add", "--detach", linked]);
  h.release(nodeId);
  await assert.rejects(h.prepare(nodeId), PENDING_REBUILD);
  assert.equal(
    (
      await simpleGit(first.directory).revparse([
        `refs/heads/${first.nodeBranch}`,
      ])
    ).trim(),
    pending,
  );
  assert.ok(existsSync(join(first.directory, ".git", "worktrees")));
  await assert.rejects(h.prepare(nodeId), PENDING_REBUILD);
});

test(
  "a checkout entry that the prepare cannot remove does not keep the other entries",
  { skip: process.getuid?.() === ROOT_USER },
  async (t) => {
    const h = await coderFixture(t);
    const nodeId = createIdentity("node");
    const checkouts = join(h.workspace.nodeKey(nodeId), CHECKOUTS_DIRECTORY);
    const locked = join(checkouts, "a-locked", "inner");
    mkdirSync(locked, { recursive: true, mode: 0o700 });
    writeFileSync(join(locked, "file"), "x");
    for (const name of ["b-removed", "c-removed"]) {
      mkdirSync(join(checkouts, name));
      writeFileSync(join(checkouts, name, "file"), "x");
    }
    chmodSync(locked, 0o500);
    try {
      await h.prepare(nodeId);
      assert.deepEqual(readdirSync(checkouts).sort(), [
        "a-locked",
        h.repository.name,
      ]);
      assert.deepEqual(
        h.logs
          .filter(({ msg }) => msg !== TREE_PREPARED)
          .map(({ fields }) => fields.path),
        [join(checkouts, "a-locked")],
      );
      h.release(nodeId);
    } finally {
      chmodSync(locked, 0o700);
    }
  },
);

test("a node-key tree of a binding that changed its address is replaced by a tree of the new address", async (t) => {
  const h = await coderFixture(t);
  const nodeId = createIdentity("node");
  const first = await h.prepare(nodeId);
  const marker = join(first.directory, "ignored.txt");
  writeFileSync(marker, "x");
  const restarted = WorkspaceRoot.open(dirname(h.workspace.root));
  const other = await restartTemplate(t);
  const moved = { ...h.repository, address: join(other.root, ORIGIN_NAME) };
  const prepared = await prepareOne(restarted, {
    env,
    transport,
    sshAccess: everyBindingSshAccess,
    context: background,
    deadlineMs: GIT_DEADLINE_MS,
    nodeId,
    nodeBranch: first.nodeBranch,
    pushed: false,
    repository: moved,
    log: (msg, fields) => h.logs.push({ msg, fields }),
  });
  assert.equal(existsSync(marker), false);
  assert.equal(
    (
      await simpleGit(prepared.directory).raw([
        "config",
        "--get",
        "remote.origin.url",
      ])
    ).trim(),
    moved.address,
  );
  assert.deepEqual(h.sources(), [
    ["coder", "clone"],
    ["coder", "clone"],
  ]);
  restarted.release(restarted.nodeKey(nodeId), WorkspaceKind.Node);
});

test("a node-key tree with a pending push whose binding changed its address stays and the preparation refuses", async (t) => {
  const h = await coderFixture(t);
  const nodeId = createIdentity("node");
  const first = await h.prepare(nodeId);
  const pending = await h.commit(first.directory, "work", "unpushed");
  writePushRecord(h.recordKey(nodeId, first.nodeBranch), {
    confirmed: null,
    pending,
  });
  h.release(nodeId);
  const other = await restartTemplate(t);
  const moved = { ...h.repository, address: join(other.root, ORIGIN_NAME) };
  await assert.rejects(
    prepareOne(h.workspace, {
      env,
      transport,
      sshAccess: everyBindingSshAccess,
      context: background,
      deadlineMs: GIT_DEADLINE_MS,
      nodeId,
      nodeBranch: first.nodeBranch,
      pushed: false,
      repository: moved,
    }),
    PENDING_REBUILD,
  );
  assert.equal(
    (
      await simpleGit(first.directory).raw([
        "config",
        "--get",
        "remote.origin.url",
      ])
    ).trim(),
    h.origin,
  );
  assert.equal(
    (
      await simpleGit(first.directory).revparse([
        `refs/heads/${first.nodeBranch}`,
      ])
    ).trim(),
    pending,
  );
});
