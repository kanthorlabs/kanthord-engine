import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { background, CancellationContext } from "../../kernel/context.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import {
  PoolClass,
  prepareTree,
  repoKeyOf,
  TreePool,
  TreeSource,
} from "./tree-pool.ts";

const env = hostEnvironment();
const ADDRESS = "ssh://git@example.invalid/one.git";
const OTHER_ADDRESS = "ssh://git@example.invalid/two.git";
const NODE_A = "node_01JABCDEFGHJKMNPQRSTVWXYZ0";
const NODE_B = "node_01JABCDEFGHJKMNPQRSTVWXYZ1";
const NODE_C = "node_01JABCDEFGHJKMNPQRSTVWXYZ2";
const MARKER = "marker";
const METADATA = ["", ".git", "kanthord-pool.json"];
const OLD_SECONDS = 1000000;
const ROUNDS = 3;
const NO_TREES = 0;
const A = "a";
const TRACKED = "tracked";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function tree(root: string, name: string): string {
  const directory = join(root, "trees", name);
  mkdirSync(join(directory, ".git"), { recursive: true });
  writeFileSync(join(directory, MARKER), name);
  return directory;
}

function freeTree(
  pool: TreePool,
  address: string,
  poolClass: PoolClass,
  name: string,
  returnedAt: number,
  nodeId: string | null = null,
): string {
  const directory = join(
    pool.root,
    repoKeyOf(address),
    poolClass,
    randomUUID(),
  );
  mkdirSync(join(directory, ".git"), { recursive: true });
  writeFileSync(join(directory, MARKER), name);
  writeFileSync(
    join(directory, ...METADATA),
    JSON.stringify({ node_id: nodeId, returned_at: returnedAt }),
  );
  return directory;
}

function markers(pool: TreePool, address: string, poolClass: PoolClass) {
  const directory = join(pool.root, repoKeyOf(address), poolClass);
  return readdirSync(directory)
    .map((name) => readFileSync(join(directory, name, MARKER), "utf8"))
    .sort();
}

function target(root: string): string {
  return join(root, "node", "checkouts", "repo");
}

test("two takers of one free tree get one tree and one clone", (t) => {
  const root = temporary(t);
  const first = TreePool.open(join(root, "pool"));
  first.give(
    { address: ADDRESS, poolClass: PoolClass.Agent },
    tree(root, "a"),
    NODE_A,
  );
  let raced = false;
  const second = TreePool.open(join(root, "pool"), {
    rename: (from, to) => {
      if (!raced) {
        raced = true;
        assert.equal(
          first.take(
            { address: ADDRESS, poolClass: PoolClass.Agent },
            join(root, "first"),
            NODE_A,
          ),
          true,
        );
      }
      renameSync(from, to);
    },
  });
  assert.equal(
    second.take(
      { address: ADDRESS, poolClass: PoolClass.Agent },
      join(root, "second"),
      NODE_A,
    ),
    false,
  );
  assert.equal(readFileSync(join(root, "first", MARKER), "utf8"), A);
  assert.equal(existsSync(join(root, "second")), false);
});

test("a take into a missing parent directory creates the parent and takes the tree", (t) => {
  const root = temporary(t);
  const pool = TreePool.open(join(root, "pool"));
  pool.give(
    { address: ADDRESS, poolClass: PoolClass.Command },
    tree(root, "a"),
    null,
  );
  assert.equal(
    pool.take(
      { address: ADDRESS, poolClass: PoolClass.Command },
      target(root),
      null,
    ),
    true,
  );
  assert.equal(readFileSync(join(target(root), MARKER), "utf8"), A);
});

test("a take that meets EXDEV answers false and keeps the free tree", (t) => {
  const root = temporary(t);
  const pool = TreePool.open(join(root, "pool"), {
    rename: () => {
      throw errno("EXDEV");
    },
  });
  freeTree(pool, ADDRESS, PoolClass.Agent, "a", 1);
  assert.equal(
    pool.take(
      { address: ADDRESS, poolClass: PoolClass.Agent },
      target(root),
      null,
    ),
    false,
  );
  assert.deepEqual(markers(pool, ADDRESS, PoolClass.Agent), ["a"]);
});

test("a give that meets EXDEV deletes the tree", (t) => {
  const root = temporary(t);
  const pool = TreePool.open(join(root, "pool"), {
    rename: () => {
      throw errno("EXDEV");
    },
  });
  const given = tree(root, "a");
  pool.give({ address: ADDRESS, poolClass: PoolClass.Agent }, given, null);
  assert.equal(existsSync(given), false);
  assert.equal(
    existsSync(join(pool.root, repoKeyOf(ADDRESS), PoolClass.Agent)) &&
      readdirSync(join(pool.root, repoKeyOf(ADDRESS), PoolClass.Agent)).length >
        NO_TREES,
    false,
  );
});

test("a give above the limit deletes the tree with the oldest stored return time", (t) => {
  const root = temporary(t);
  const pool = TreePool.open(join(root, "pool"));
  const older = freeTree(pool, ADDRESS, PoolClass.Command, "older", 100);
  const newer = freeTree(pool, ADDRESS, PoolClass.Command, "newer", 200);
  for (const path of [newer, join(newer, ".git"), join(newer, ...METADATA)])
    utimesSync(path, OLD_SECONDS, OLD_SECONDS);
  assert.equal(existsSync(older), true);
  freeTree(pool, ADDRESS, PoolClass.Agent, "agent-old", 100);
  pool.give(
    { address: ADDRESS, poolClass: PoolClass.Command },
    tree(root, "given"),
    null,
  );
  assert.deepEqual(markers(pool, ADDRESS, PoolClass.Command), [
    "given",
    "newer",
  ]);
  assert.equal(existsSync(newer), true);
  pool.give(
    { address: ADDRESS, poolClass: PoolClass.Agent },
    tree(root, "agent-new"),
    null,
  );
  assert.deepEqual(markers(pool, ADDRESS, PoolClass.Agent), ["agent-new"]);
  assert.deepEqual(
    readdirSync(join(pool.root, repoKeyOf(ADDRESS), PoolClass.Command)).filter(
      (name) => name.startsWith("."),
    ),
    [],
  );
});

test("a take prefers the tree that the same node gave back", (t) => {
  for (let round = 0; round < ROUNDS; round += 1) {
    const root = join(temporary(t), String(round));
    const pool = TreePool.open(join(root, "pool"));
    freeTree(pool, ADDRESS, PoolClass.Command, "from-a", 100, NODE_A);
    freeTree(pool, ADDRESS, PoolClass.Command, "from-b", 300, NODE_B);
    freeTree(pool, ADDRESS, PoolClass.Command, "from-none", 200);
    for (const [name, node] of [
      ["from-a", NODE_A],
      ["from-b", NODE_C],
      ["from-none", NODE_C],
    ] as const) {
      const taken = join(root, "taken", name);
      assert.equal(
        pool.take(
          { address: ADDRESS, poolClass: PoolClass.Command },
          taken,
          node,
        ),
        true,
      );
      assert.equal(readFileSync(join(taken, MARKER), "utf8"), name);
    }
  }
});

test("a tree of one repository never serves another", (t) => {
  const root = temporary(t);
  const pool = TreePool.open(join(root, "pool"));
  pool.give(
    { address: ADDRESS, poolClass: PoolClass.Agent },
    tree(root, "a"),
    NODE_A,
  );
  assert.equal(
    pool.take(
      { address: OTHER_ADDRESS, poolClass: PoolClass.Agent },
      target(root),
      NODE_A,
    ),
    false,
  );
  assert.notEqual(repoKeyOf(ADDRESS), repoKeyOf(OTHER_ADDRESS));
  assert.match(repoKeyOf(ADDRESS), /^[0-9a-f]{32}$/);
});

test("an agent tree never serves the command class", (t) => {
  const root = temporary(t);
  const pool = TreePool.open(join(root, "pool"));
  pool.give(
    { address: ADDRESS, poolClass: PoolClass.Agent },
    tree(root, "a"),
    NODE_A,
  );
  assert.equal(
    pool.take(
      { address: ADDRESS, poolClass: PoolClass.Command },
      target(root),
      NODE_A,
    ),
    false,
  );
  assert.deepEqual(markers(pool, ADDRESS, PoolClass.Agent), ["a"]);
});

test("the pool deletes an eviction leftover when it opens", (t) => {
  const root = temporary(t);
  const first = TreePool.open(join(root, "pool"));
  const kept = freeTree(first, ADDRESS, PoolClass.Agent, "kept", 1);
  const leftover = join(
    first.root,
    repoKeyOf(ADDRESS),
    PoolClass.Agent,
    `.evict-${randomUUID()}`,
  );
  mkdirSync(join(leftover, ".git"), { recursive: true });
  TreePool.open(join(root, "pool"));
  assert.equal(existsSync(leftover), false);
  assert.equal(existsSync(kept), true);
});

async function gitTree(t: TestContext, removed: string[] = []) {
  const root = temporary(t);
  const origin = join(root, "origin");
  mkdirSync(origin);
  await simpleGit(origin).raw(["init", "-b", "main"]);
  writeFileSync(join(origin, "tracked"), "tracked");
  await simpleGit(origin).add("tracked");
  await simpleGit(origin).raw([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  const pool = TreePool.open(join(root, "pool"), {
    remove: (path) => {
      removed.push(path);
      rmSync(path, { recursive: true, force: true });
    },
  });
  const given = join(root, "given");
  await simpleGit(root).clone(origin, given);
  pool.give({ address: origin, poolClass: PoolClass.Agent }, given, NODE_A);
  return { root, origin, pool };
}

function preparation(
  at: Awaited<ReturnType<typeof gitTree>>,
  calls: string[],
  reuse: () => Promise<void>,
  context = background,
) {
  const directory = target(at.root);
  return prepareTree({
    pool: at.pool,
    poolClass: PoolClass.Agent,
    address: at.origin,
    target: directory,
    nodeId: NODE_A,
    keepRefs: [],
    env,
    context,
    deadlineMs: 30000,
    fresh: async () => {
      calls.push(existsSync(directory) ? "fresh-over-tree" : "fresh");
      mkdirSync(directory, { recursive: true });
    },
    reuse: async () => {
      calls.push("reuse");
      await reuse();
    },
  });
}

test("a prepared tree comes from the pool when one is free and from a clone when none is", async (t) => {
  const at = await gitTree(t);
  const calls: string[] = [];
  assert.deepEqual(await preparation(at, calls, async () => {}), {
    source: TreeSource.Pool,
  });
  assert.equal(readFileSync(join(target(at.root), TRACKED), "utf8"), TRACKED);
  const empty = { ...at, root: join(at.root, "second") };
  assert.deepEqual(await preparation(empty, calls, async () => {}), {
    source: TreeSource.Clone,
  });
  assert.deepEqual(calls, ["reuse", "fresh"]);
});

test("a failed scrub deletes the taken tree and clones fresh once", async (t) => {
  const at = await gitTree(t);
  const calls: string[] = [];
  assert.deepEqual(
    await preparation(at, calls, async () => {
      throw new Error("git exited with 128");
    }),
    { source: TreeSource.Clone },
  );
  assert.deepEqual(calls, ["reuse", "fresh"]);
});

test("a taken tree that answers rebuild is deleted and cloned fresh", async (t) => {
  const at = await gitTree(t);
  const taken = join(at.root, "taken");
  assert.equal(
    at.pool.take(
      { address: at.origin, poolClass: PoolClass.Agent },
      taken,
      NODE_A,
    ),
    true,
  );
  writeFileSync(join(taken, ".git", "shallow"), "");
  at.pool.give(
    { address: at.origin, poolClass: PoolClass.Agent },
    taken,
    NODE_A,
  );
  const calls: string[] = [];
  assert.deepEqual(await preparation(at, calls, async () => {}), {
    source: TreeSource.Clone,
  });
  assert.deepEqual(calls, ["fresh"]);
});

test("a failed reuse in an aborted context throws and clones nothing", async (t) => {
  const at = await gitTree(t);
  const calls: string[] = [];
  const context = new CancellationContext();
  await assert.rejects(
    preparation(
      at,
      calls,
      async () => {
        context.cancel();
        throw new Error("aborted");
      },
      context,
    ),
  );
  assert.deepEqual(calls, ["reuse"]);
});

async function retakenWith(
  at: Awaited<ReturnType<typeof gitTree>>,
  change: (taken: string) => void,
) {
  const slot = { address: at.origin, poolClass: PoolClass.Agent };
  const taken = join(at.root, "taken");
  assert.equal(at.pool.take(slot, taken, NODE_A), true);
  change(taken);
  at.pool.give(slot, taken, NODE_A);
}

test("a malformed .git/config makes the take rebuild", async (t) => {
  const at = await gitTree(t);
  await retakenWith(at, (taken) =>
    writeFileSync(join(taken, ".git", "config"), "[core\n"),
  );
  const calls: string[] = [];
  assert.deepEqual(await preparation(at, calls, async () => {}), {
    source: TreeSource.Clone,
  });
  assert.deepEqual(calls, ["fresh"]);
});

test("a rebuilt or failed tree is deleted with the pool remover", async (t) => {
  const removed: string[] = [];
  const at = await gitTree(t, removed);
  await retakenWith(at, (taken) =>
    writeFileSync(join(taken, ".git", "shallow"), ""),
  );
  await preparation(at, [], async () => {});
  assert.deepEqual(removed, [target(at.root)]);
});
