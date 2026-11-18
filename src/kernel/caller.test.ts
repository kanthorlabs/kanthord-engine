import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isDelegateIdentity,
  isReadOnlyIdentity,
  projectScopeOf,
} from "./caller.ts";
import { testDelegateIdentity, testReadOnlyIdentity } from "./test-identity.ts";

test("security: a copy of a read-only identity carries no mark", () => {
  const projectId = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const reader = testReadOnlyIdentity("ulrich", {
    inviteId: "workbench_invite_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    projectIds: [projectId],
    guestName: "Mira",
  });
  assert.ok(isReadOnlyIdentity(reader));
  assert.ok(projectScopeOf(reader)?.has(projectId));
  const copy = { ...reader };
  assert.equal(isReadOnlyIdentity(copy), false);
  assert.equal(projectScopeOf(copy), null);
});

const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const MAX_NAME_LENGTH = 64;
const TOOL_CALL = "call-1";
const NO_PROJECTS = 0;
const GUEST_SUFFIX = " (guest)";

test("(security: argument guard) a delegate name of 64 emoji stays within 64 UTF-16 units, ends with the guest suffix and splits no surrogate pair", () => {
  const delegate = testDelegateIdentity("ulrich", {
    guestName: "😀".repeat(MAX_NAME_LENGTH),
    toolCallId: TOOL_CALL,
    projectIds: [],
  });
  assert.ok(delegate.name.length <= MAX_NAME_LENGTH);
  assert.ok(delegate.name.endsWith(GUEST_SUFFIX));
  assert.equal(LONE_SURROGATE.test(delegate.name), false);
  assert.equal(delegate.jti, `grant:${TOOL_CALL}`);
  assert.ok(isDelegateIdentity(delegate));
  assert.equal(projectScopeOf(delegate)?.size, NO_PROJECTS);
});
