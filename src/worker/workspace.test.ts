import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
  utimesSync,
} from "node:fs";
import { test } from "node:test";
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
  assert.ok(statSync(held).mtimeMs >= now);
  workspace.hold(execution);
  workspace.release(execution, WorkspaceKind.Execution);
  assert.equal(existsSync(execution), false);
  workspace.startSweeping();
  workspace.stopSweeping();
});
