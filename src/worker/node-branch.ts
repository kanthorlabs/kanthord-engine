import assert from "node:assert/strict";
import { identitySchema } from "../kernel/identity.ts";

export const NODE_BRANCH_PREFIX = "kanthord/";
const nodeIdentity = identitySchema("node");

export function nodeBranchOf(nodeId: string): string {
  assert.ok(nodeIdentity.safeParse(nodeId).success);
  const branch = NODE_BRANCH_PREFIX + nodeId;
  assert.ok(branch.startsWith(NODE_BRANCH_PREFIX));
  return branch;
}
