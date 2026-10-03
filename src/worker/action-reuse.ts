import assert from "node:assert/strict";
import { z } from "zod";
import type { ActionContext, ActionOperands } from "./contract.ts";

export const PullRequestState = { Open: "open" } as const;
export const REPOSITORY_IDENTITY_PREFIX = "repository:github:";
const repositorySchema = z.looseObject({ full_name: z.string() });
const branchSchema = z.looseObject({ ref: z.string(), repo: repositorySchema });
const pullRequestSchema = z.looseObject({
  state: z.string(),
  head: branchSchema,
  base: branchSchema,
});
const OWNER_REPOSITORY = /^[^/]+\/[^/]+$/;

export function repositoryOf(resourceIdentity: string): string {
  assert.ok(resourceIdentity.startsWith(REPOSITORY_IDENTITY_PREFIX));
  const repository = resourceIdentity.slice(REPOSITORY_IDENTITY_PREFIX.length);
  assert.match(repository, OWNER_REPOSITORY);
  return repository;
}

export function fulfils(
  body: unknown,
  operands: ActionOperands,
  resourceIdentity: string,
): boolean {
  assert.ok(operands.nodeBranch);
  assert.ok(operands.baseBranch);
  const parsed = pullRequestSchema.safeParse(body);
  if (!parsed.success) return false;
  const repository = repositoryOf(resourceIdentity).toLowerCase();
  const { state, head, base } = parsed.data;
  return (
    state === PullRequestState.Open &&
    head.ref === operands.nodeBranch &&
    base.ref === operands.baseBranch &&
    head.repo.full_name.toLowerCase() === repository &&
    base.repo.full_name.toLowerCase() === repository
  );
}

export function sameRepository(
  candidate: ActionContext["actions"][number]["reuseCandidates"][number],
  resourceIdentity: string,
): boolean {
  assert.ok(candidate.evidenceId);
  assert.ok(resourceIdentity);
  return candidate.address.resourceIdentity === resourceIdentity;
}
