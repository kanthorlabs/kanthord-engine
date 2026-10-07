import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../kernel/context.ts";
import * as connector from "../repository/connector.ts";
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  nodeBranchOf,
  WorkspaceKind,
  WorkspaceRoot,
  WORKSPACE_RETENTION_MS,
} from "./workspace.ts";

const transport = { ...connector, proveSshIdentity: async () => {} };

test("workspace root audits private mode and keys refuse foreign identities", (t) => {
  const expectedBranch = "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA";
  const state = temporary(t);
  const workspace = WorkspaceRoot.open(state);
  const mode = 0o700;
  assert.equal(statSync(workspace.root).mode & 0o777, mode);
  assert.throws(() => workspace.objectiveKey("../x"));
  assert.throws(() => workspace.executionKey(createIdentity("node")));
  assert.throws(() =>
    workspace.objectiveDirectory(
      createIdentity("node"),
      createIdentity("execution"),
    ),
  );
  assert.equal(nodeBranchOf("node_01ARZ3NDEKTSV4RRFFQ69G5FAA"), expectedBranch);
  chmodSync(workspace.root, 0o755);
  assert.throws(() => WorkspaceRoot.open(state), {
    code: "system.files.invalid_permissions",
  });
});

test("workspace retention respects holds and release kind", (t) => {
  const workspace = WorkspaceRoot.open(temporary(t));
  const old = workspace.objectiveKey(createIdentity("node"));
  const recent = workspace.objectiveKey(createIdentity("node"));
  const held = workspace.objectiveKey(createIdentity("node"));
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
  workspace.release(held, WorkspaceKind.Objective);
  assert.ok(statSync(held).mtimeMs > now - WORKSPACE_RETENTION_MS);
  workspace.hold(execution);
  workspace.release(execution, WorkspaceKind.Execution);
  assert.equal(existsSync(execution), false);
  workspace.startSweeping();
  workspace.stopSweeping();
});

test("workspace preparation refreshes objective branches and creates disposable snapshots and initiatives", async (t) => {
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
  const objectiveId = createIdentity("node");
  const repository = {
    binding_id: createIdentity("binding"),
    address: origin,
    ssh_identity: {
      host: "github.com",
      hostname: "github.com",
      port: 22,
      identity_file: "~/.ssh/id_test",
    },
    strategy: { base_branch: "main" },
  };
  const common = { transport, context: background, deadlineMs: 10000 };
  const first = await workspace.prepareObjective({
    ...common,
    objectiveId,
    repository,
  });
  assert.equal(first.head, base);
  const pushed = await commit(first.directory, "pushed");
  await transport.pushNodeBranch(
    first.directory,
    first.nodeBranch,
    background,
    10000,
  );
  await commit(first.directory, "unpushed");
  workspace.release(
    workspace.objectiveKey(objectiveId),
    WorkspaceKind.Objective,
  );
  const second = await workspace.prepareObjective({
    ...common,
    objectiveId,
    repository,
  });
  assert.equal(second.directory, first.directory);
  assert.equal(second.head, pushed);
  workspace.release(
    workspace.objectiveKey(objectiveId),
    WorkspaceKind.Objective,
  );
  const snapshot = await workspace.prepareSnapshot({
    ...common,
    executionId: createIdentity("execution"),
    repository,
    commit: pushed,
  });
  assert.equal(snapshot.head, pushed);
  workspace.release(snapshot.directory, WorkspaceKind.Execution);
  const another = { ...repository, binding_id: createIdentity("binding") };
  const initiative = await workspace.prepareInitiative({
    ...common,
    executionId: createIdentity("execution"),
    repositories: [repository, another],
  });
  assert.deepEqual(
    initiative.testedInput,
    [repository, another].map(({ binding_id }) => ({
      kind: "repository",
      bindingId: binding_id,
      commit: base,
    })),
  );
  workspace.release(initiative.directory, WorkspaceKind.Execution);
  const empty = await workspace.prepareInitiative({
    ...common,
    executionId: createIdentity("execution"),
    repositories: [],
  });
  assert.equal(empty.testedInput, null);
  workspace.release(empty.directory, WorkspaceKind.Execution);
  const failedId = createIdentity("node");
  await assert.rejects(
    workspace.prepareObjective({
      ...common,
      objectiveId: failedId,
      repository: { ...repository, address: join(state, "missing") },
    }),
  );
  const retried = await workspace.prepareObjective({
    ...common,
    objectiveId: failedId,
    repository,
  });
  assert.equal(retried.head, base);
  workspace.release(workspace.objectiveKey(failedId), WorkspaceKind.Objective);
});

test("a drifted SSH identity stops every workspace preparation before its git operation", async (t) => {
  const workspace = WorkspaceRoot.open(temporary(t));
  const drift = new Error("repository.credential.ssh_drift");
  const proved: string[] = [];
  const refusing = {
    ...connector,
    proveSshIdentity: async (pin: { host: string }) => {
      proved.push(pin.host);
      throw drift;
    },
    clone: async () => assert.fail("The clone must not run."),
    cloneSnapshot: async () => assert.fail("The clone must not run."),
    fetchAndCheckout: async () => assert.fail("The fetch must not run."),
  };
  const repository = {
    binding_id: createIdentity("binding"),
    address: "git@kanthorlabs.github.com:kanthorlabs/kanthord.git",
    ssh_identity: {
      host: "kanthorlabs.github.com",
      hostname: "ssh.github.com",
      port: 443,
      identity_file: "~/.ssh/id_kanthorlabs",
    },
    strategy: { base_branch: "main" },
  };
  const common = {
    transport: refusing,
    context: background,
    deadlineMs: 10000,
  };
  await assert.rejects(
    workspace.prepareObjective({
      ...common,
      objectiveId: createIdentity("node"),
      repository,
    }),
    (error) => error === drift,
  );
  await assert.rejects(
    workspace.prepareSnapshot({
      ...common,
      executionId: createIdentity("execution"),
      repository,
      commit: "head",
    }),
    (error) => error === drift,
  );
  await assert.rejects(
    workspace.prepareInitiative({
      ...common,
      executionId: createIdentity("execution"),
      repositories: [repository],
    }),
    (error) => error === drift,
  );
  assert.deepEqual(proved, Array(3).fill(repository.ssh_identity.host));
});
