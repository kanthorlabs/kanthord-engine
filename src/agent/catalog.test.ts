import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BuiltinTool,
  EnvironmentTool,
  getProfile,
  PROFILE_NAMES,
  StartPrecondition,
  TOOL_CATALOG,
  WorkerTool,
} from "./catalog.ts";

test("unknown and inherited names give no profile", () => {
  assert.equal(getProfile("unknown"), undefined);
  assert.equal(getProfile("constructor"), undefined);
  assert.equal(getProfile("__proto__"), undefined);
});

test("swe@1 has the exact tool set, confinement and preconditions", () => {
  const profile = getProfile("swe@1");
  assert.ok(profile);
  assert.deepEqual(
    profile.tools.builtin.toSorted(),
    [
      BuiltinTool.Bash,
      BuiltinTool.Edit,
      BuiltinTool.Find,
      BuiltinTool.Grep,
      BuiltinTool.Ls,
      BuiltinTool.Read,
      BuiltinTool.Write,
    ].toSorted(),
  );
  assert.deepEqual(
    profile.tools.host.toSorted(),
    [WorkerTool.EvidenceUpload, WorkerTool.LinkUpdateList].toSorted(),
  );
  assert.deepEqual(profile.tools.environment, []);
  assert.equal(profile.confined, false);
  assert.deepEqual(profile.preconditions, [
    StartPrecondition.WorkspaceDirectory,
    StartPrecondition.GitWorktree,
    StartPrecondition.GitClean,
  ]);
});

test("re@1 has the exact tool set, confinement and preconditions", () => {
  const profile = getProfile("re@1");
  assert.ok(profile);
  assert.deepEqual(
    profile.tools.builtin.toSorted(),
    [
      BuiltinTool.Find,
      BuiltinTool.Grep,
      BuiltinTool.Ls,
      BuiltinTool.Read,
    ].toSorted(),
  );
  assert.deepEqual(profile.tools.host, []);
  assert.deepEqual(profile.tools.environment, []);
  assert.equal(profile.confined, true);
  assert.deepEqual(profile.preconditions, [
    StartPrecondition.WorkspaceDirectory,
  ]);
});

test("env@1 has the exact tool set, confinement and preconditions", () => {
  const profile = getProfile("env@1");
  assert.ok(profile);
  assert.deepEqual(
    profile.tools.builtin.toSorted(),
    [
      BuiltinTool.Find,
      BuiltinTool.Grep,
      BuiltinTool.Ls,
      BuiltinTool.Read,
    ].toSorted(),
  );
  assert.deepEqual(profile.tools.host, []);
  assert.deepEqual(
    profile.tools.environment.toSorted(),
    [EnvironmentTool.EnvironmentWrite, EnvironmentTool.Probe].toSorted(),
  );
  assert.equal(profile.confined, true);
  assert.deepEqual(profile.preconditions, [
    StartPrecondition.WorkspaceDirectory,
  ]);
});

test("each declared tool except bash has a TOOL_CATALOG entry", () => {
  for (const name of PROFILE_NAMES) {
    const profile = getProfile(name);
    assert.ok(profile);
    for (const tool of profile.tools.builtin) {
      if (tool === BuiltinTool.Bash) continue;
      assert.ok(
        Object.hasOwn(TOOL_CATALOG, tool),
        `missing TOOL_CATALOG entry for ${tool}`,
      );
    }
    for (const tool of profile.tools.host) {
      assert.ok(
        Object.hasOwn(TOOL_CATALOG, tool),
        `missing TOOL_CATALOG entry for ${tool}`,
      );
    }
    for (const tool of profile.tools.environment) {
      assert.ok(
        Object.hasOwn(TOOL_CATALOG, tool),
        `missing TOOL_CATALOG entry for ${tool}`,
      );
    }
  }
});
