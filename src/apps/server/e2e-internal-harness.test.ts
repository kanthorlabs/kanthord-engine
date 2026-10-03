import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import type { RepositoryTransport } from "../../worker/index.ts";
import { REPOSITORY_ADDRESS } from "./journey-support.ts";

const GIT_TIMEOUT_MS = 10000;
const MAIN_REF = "refs/heads/main";
const TEST_BRANCH = "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA";

async function bareRepository(t: TestContext, name: string) {
  const root = temporary(t);
  const bare = join(root, `${name}.git`);
  const seed = join(root, "seed");
  mkdirSync(bare);
  await simpleGit(bare).init(true, ["--initial-branch=main"]);
  await simpleGit().clone(bare, seed);
  const git = simpleGit(seed);
  await git.addConfig("user.name", "Test Journey");
  await git.addConfig("user.email", "test_journey@example.invalid");
  writeFileSync(join(seed, "README.md"), "test_journey repository\n");
  await git.add("README.md");
  await git.commit("initial");
  await git.push("origin", "main");
  const head = (await git.revparse(["HEAD"])).trim();
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.equal(await remoteHead(bare, MAIN_REF), head);
  return { bare, head };
}

function mappedTransport(
  addresses: Record<string, string>,
): RepositoryTransport {
  const connector = new RepositoryComponent();
  function mapped(address: string) {
    assert.ok(Object.hasOwn(addresses, address), "Unmapped repository address");
    assert.ok(addresses[address]);
    return addresses[address]!;
  }
  return {
    clone: (address, ...args) => connector.clone(mapped(address), ...args),
    cloneSnapshot: (address, ...args) =>
      connector.cloneSnapshot(mapped(address), ...args),
    fetchAndCheckout: (...args) => connector.fetchAndCheckout(...args),
    pushNodeBranch: (...args) => connector.pushNodeBranch(...args),
  };
}

async function remoteHead(bare: string, ref: string): Promise<string | null> {
  assert.ok(bare.startsWith("/"));
  assert.ok(ref.startsWith("refs/heads/"));
  const output = (await simpleGit().raw(["ls-remote", bare, ref])).trim();
  if (!output) return null;
  const [head, found] = output.split(/\s+/);
  assert.equal(found, ref);
  assert.match(head!, /^[a-f0-9]{40}$/);
  return head!;
}

test("local mapped repository clones main and publishes only the node branch", async (t) => {
  const repo = await bareRepository(t, "test_repo");
  const transport = mappedTransport({ [REPOSITORY_ADDRESS]: repo.bare });
  const checkout = join(temporary(t), "checkout");
  mkdirSync(checkout);
  await transport.clone(
    REPOSITORY_ADDRESS,
    checkout,
    background,
    GIT_TIMEOUT_MS,
  );
  assert.equal(
    (await simpleGit(checkout).revparse(["HEAD"])).trim(),
    repo.head,
  );
  assert.equal(await remoteHead(repo.bare, `refs/heads/${TEST_BRANCH}`), null);
  await transport.fetchAndCheckout(
    checkout,
    TEST_BRANCH,
    "main",
    background,
    GIT_TIMEOUT_MS,
  );
  await transport.pushNodeBranch(
    checkout,
    TEST_BRANCH,
    background,
    GIT_TIMEOUT_MS,
  );
  assert.equal(
    await remoteHead(repo.bare, `refs/heads/${TEST_BRANCH}`),
    repo.head,
  );
  assert.equal(await remoteHead(repo.bare, MAIN_REF), repo.head);
  assert.throws(
    () =>
      transport.clone("test_unmapped", checkout, background, GIT_TIMEOUT_MS),
    assert.AssertionError,
  );
});
