import assert from "node:assert/strict";
import { test } from "node:test";
import { fulfils, repositoryOf, sameRepository } from "./action-reuse.ts";
import { PlatformAddressKind } from "./contract.ts";

const RESOURCE = "repository:github:owner/repo";
const REPOSITORY = "owner/repo";
const operands = {
  nodeBranch: "kanthord/node",
  baseBranch: "main",
  commit: "b".repeat(40),
  reusedAddress: null,
};
const body = {
  state: "open",
  head: { ref: operands.nodeBranch, repo: { full_name: "owner/repo" } },
  base: { ref: operands.baseBranch, repo: { full_name: "owner/repo" } },
};

test("reuse accepts an open matching pull request and ignores extra platform fields", () => {
  assert.equal(fulfils(body, operands, RESOURCE), true);
  assert.equal(
    fulfils(
      { ...body, url: "https://github.com/owner/repo/pull/42" },
      operands,
      RESOURCE,
    ),
    true,
  );
});

test("reuse refuses closed, merged, other branches, forks and malformed bodies", () => {
  const bodies = [
    { ...body, state: "closed" },
    { ...body, state: "merged" },
    { ...body, head: { ...body.head, ref: "other" } },
    { ...body, base: { ...body.base, ref: "other" } },
    { ...body, head: { ...body.head, repo: { full_name: "fork/repo" } } },
    { ...body, base: { ...body.base, repo: { full_name: "other/repo" } } },
    { ...body, head: { ref: operands.nodeBranch } },
    null,
  ];
  for (const candidate of bodies)
    assert.equal(fulfils(candidate, operands, RESOURCE), false);
  assert.equal(fulfils(body, operands, RESOURCE), true);
});

test("repository identity and candidate repository must match", () => {
  const candidate = {
    evidence_id: "evidence",
    attempt: 1,
    address: {
      kind: PlatformAddressKind.PullRequest,
      resource_identity: RESOURCE,
      number: 42,
    },
  };
  assert.equal(sameRepository(candidate, RESOURCE), true);
  assert.equal(
    sameRepository(candidate, "repository:github:other/repo"),
    false,
  );
  assert.equal(repositoryOf(RESOURCE), REPOSITORY);
  assert.throws(() => repositoryOf("storage:s3:bucket"), assert.AssertionError);
});

test("GitHub repository capitalization is equivalent while branch refs remain exact", () => {
  const mixed = {
    ...body,
    head: { ...body.head, repo: { full_name: "Owner/Repo" } },
    base: { ...body.base, repo: { full_name: "OWNER/REPO" } },
  };
  assert.equal(fulfils(mixed, operands, RESOURCE), true);
  assert.equal(fulfils(body, operands, "repository:github:Owner/Repo"), true);
  assert.equal(
    fulfils(
      {
        ...mixed,
        head: { ...mixed.head, ref: operands.nodeBranch.toUpperCase() },
      },
      operands,
      RESOURCE,
    ),
    false,
  );
  assert.equal(
    fulfils(
      {
        ...mixed,
        base: { ...mixed.base, ref: operands.baseBranch.toUpperCase() },
      },
      operands,
      RESOURCE,
    ),
    false,
  );
  assert.equal(
    fulfils(
      { ...mixed, head: { ...mixed.head, repo: { full_name: "Fork/Repo" } } },
      operands,
      RESOURCE,
    ),
    false,
  );
});
