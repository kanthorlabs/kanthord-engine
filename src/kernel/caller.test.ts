import assert from "node:assert/strict";
import { test } from "node:test";
import { isReadOnlyIdentity, projectScopeOf } from "./caller.ts";
import { testReadOnlyIdentity } from "./test-identity.ts";

test("security: a copy of a read-only identity carries no mark", () => {
  const projectId = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const reader = testReadOnlyIdentity("ulrich", {
    inviteId: "workbench_invite_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    projectIds: [projectId],
  });
  assert.ok(isReadOnlyIdentity(reader));
  assert.ok(projectScopeOf(reader)?.has(projectId));
  const copy = { ...reader };
  assert.equal(isReadOnlyIdentity(copy), false);
  assert.equal(projectScopeOf(copy), null);
});
