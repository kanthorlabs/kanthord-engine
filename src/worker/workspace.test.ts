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
import * as transport from "../repository/connector.ts";
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  nodeBranchOf,
  WorkspaceKind,
  WorkspaceRoot,
  WORKSPACE_RETENTION_MS,
} from "./workspace.ts";

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
    bindingId: createIdentity("binding"),
    address: origin,
    strategy: { baseBranch: "main" },
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
  const another = { ...repository, bindingId: createIdentity("binding") };
  const initiative = await workspace.prepareInitiative({
    ...common,
    executionId: createIdentity("execution"),
    repositories: [repository, another],
  });
  assert.deepEqual(
    initiative.testedInput,
    [repository, another].map(({ bindingId }) => ({
      kind: "repository",
      bindingId,
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
