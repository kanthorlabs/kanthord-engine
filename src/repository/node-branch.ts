import assert from "node:assert/strict";
import { identitySchema } from "../kernel/identity.ts";

const NODE_BRANCH_PREFIX = "kanthord/";
export const NODE_BRANCH_PATTERN =
  /^kanthord\/node_[0-7][0-9A-HJKMNP-TV-Z]{25}(?:-a(?:[2-9]|[1-9][0-9]+))?$/;
const FIRST_ATTEMPT = 1;
const ATTEMPT_SUFFIX = "-a";
const nodeIdentity = identitySchema("node");

export function nodeBranchOf(nodeId: string, startAttempt: number): string {
  assert.ok(nodeIdentity.safeParse(nodeId).success);
  assert.ok(
    Number.isSafeInteger(startAttempt) && startAttempt >= FIRST_ATTEMPT,
  );
  const branch =
    startAttempt === FIRST_ATTEMPT
      ? NODE_BRANCH_PREFIX + nodeId
      : NODE_BRANCH_PREFIX + nodeId + ATTEMPT_SUFFIX + startAttempt;
  assert.match(branch, NODE_BRANCH_PATTERN);
  return branch;
}
