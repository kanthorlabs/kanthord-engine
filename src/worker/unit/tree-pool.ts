import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Context } from "../../kernel/context.ts";
import {
  ensureDirectory,
  FILE_NOT_FOUND,
  writePrivate,
} from "../../kernel/files.ts";
import { GitState, normaliseGitState } from "./local-git.ts";

export const PoolClass = { Agent: "agent", Command: "command" } as const;
export type PoolClass = (typeof PoolClass)[keyof typeof PoolClass];
export const TreeSource = { Pool: "pool", Clone: "clone" } as const;
export type TreeSource = (typeof TreeSource)[keyof typeof TreeSource];
export const AGENT_FREE_TREES_MAX = 1;
export const COMMAND_FREE_TREES_MAX = 2;
export const POOL_DIRECTORY = "pool";
export const POOL_METADATA_FILE = "kanthord-pool.json";
const FREE_TREES_MAX: Readonly<Record<PoolClass, number>> = {
  [PoolClass.Agent]: AGENT_FREE_TREES_MAX,
  [PoolClass.Command]: COMMAND_FREE_TREES_MAX,
};
const REPO_KEY_LENGTH = 32;
const NO_RETURN_TIME = 0;
const EVICT_PREFIX = ".evict-";
const CROSS_DEVICE = "EXDEV";
const GIT_DIRECTORY = ".git";
const TREE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REPO_KEY_PATTERN = /^[0-9a-f]{32}$/;

const poolMetadataSchema = z.strictObject({
  node_id: z.string().nullable(),
  returned_at: z.int().min(0),
});
type PoolMetadata = z.infer<typeof poolMetadataSchema>;

export interface FreeTree {
  path: string;
  node_id: string | null;
  returned_at: number;
}

export interface PoolSlot {
  address: string;
  poolClass: PoolClass;
}

export interface TreePoolOptions {
  rename?: (from: string, to: string) => void;
  remove?: (path: string) => void;
}

export function repoKeyOf(address: string): string {
  return createHash("sha256")
    .update(address)
    .digest("hex")
    .slice(0, REPO_KEY_LENGTH);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function namesOf(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch (error) {
    if (errorCode(error) === FILE_NOT_FOUND) return [];
    throw error;
  }
}

function metadataOf(tree: string): PoolMetadata {
  try {
    return poolMetadataSchema.parse(
      JSON.parse(
        readFileSync(join(tree, GIT_DIRECTORY, POOL_METADATA_FILE), "utf8"),
      ),
    );
  } catch {
    return { node_id: null, returned_at: NO_RETURN_TIME };
  }
}

function freeTreesOf(directory: string): FreeTree[] {
  return namesOf(directory)
    .filter((name) => TREE_ID_PATTERN.test(name))
    .map((name) => join(directory, name))
    .filter((path) => lstatSync(path, { throwIfNoEntry: false })?.isDirectory())
    .map((path) => ({ path, ...metadataOf(path) }));
}

function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export class TreePool {
  readonly root: string;
  private readonly rename: (from: string, to: string) => void;
  readonly remove: (path: string) => void;
  private constructor(root: string, options: TreePoolOptions) {
    this.root = root;
    this.rename = options.rename ?? renameSync;
    this.remove = options.remove ?? removeTree;
  }

  static open(root: string, options: TreePoolOptions = {}): TreePool {
    ensureDirectory(root);
    const pool = new TreePool(root, options);
    for (const directory of pool.classDirectories())
      for (const name of namesOf(directory))
        if (name.startsWith(EVICT_PREFIX)) pool.remove(join(directory, name));
    return pool;
  }

  trees(): FreeTree[] {
    return this.classDirectories().flatMap(freeTreesOf);
  }

  take(slot: PoolSlot, target: string, nodeId: string | null): boolean {
    ensureDirectory(dirname(target));
    assert.ok(!existsSync(target), "A take target must not exist");
    const trees = freeTreesOf(this.classDirectory(slot)).sort(
      (a, b) =>
        Number(b.node_id !== null && b.node_id === nodeId) -
          Number(a.node_id !== null && a.node_id === nodeId) ||
        b.returned_at - a.returned_at,
    );
    for (const tree of trees) {
      try {
        this.rename(tree.path, target);
        return true;
      } catch (error) {
        if (errorCode(error) === FILE_NOT_FOUND) continue;
        if (errorCode(error) === CROSS_DEVICE) return false;
        throw error;
      }
    }
    return false;
  }

  give(slot: PoolSlot, tree: string, nodeId: string | null): void {
    writePrivate(
      join(tree, GIT_DIRECTORY, POOL_METADATA_FILE),
      JSON.stringify({ node_id: nodeId, returned_at: Date.now() }),
      true,
    );
    const directory = this.classDirectory(slot);
    ensureDirectory(directory);
    try {
      this.rename(tree, join(directory, randomUUID()));
    } catch (error) {
      if (errorCode(error) !== CROSS_DEVICE) throw error;
      this.remove(tree);
      return;
    }
    this.evict(directory, FREE_TREES_MAX[slot.poolClass]);
  }

  giveBack(slot: PoolSlot, tree: string, nodeId: string | null): void {
    if (
      lstatSync(join(tree, GIT_DIRECTORY), {
        throwIfNoEntry: false,
      })?.isDirectory()
    )
      this.give(slot, tree, nodeId);
    else this.remove(tree);
  }

  private evict(directory: string, limit: number): void {
    for (;;) {
      const trees = freeTreesOf(directory);
      if (trees.length <= limit) return;
      const oldest = trees.reduce((a, b) =>
        b.returned_at < a.returned_at ? b : a,
      );
      const evicted = join(directory, `${EVICT_PREFIX}${randomUUID()}`);
      try {
        this.rename(oldest.path, evicted);
      } catch (error) {
        if (errorCode(error) === FILE_NOT_FOUND) continue;
        throw error;
      }
      this.remove(evicted);
    }
  }

  private classDirectory(slot: PoolSlot): string {
    return join(this.root, repoKeyOf(slot.address), slot.poolClass);
  }

  private classDirectories(): string[] {
    return namesOf(this.root)
      .filter((name) => REPO_KEY_PATTERN.test(name))
      .flatMap((name) =>
        Object.values(PoolClass).map((poolClass) =>
          join(this.root, name, poolClass),
        ),
      );
  }
}

export interface TreePreparation extends PoolSlot {
  pool: TreePool;
  target: string;
  nodeId: string | null;
  keepRefs: readonly string[];
  env: NodeJS.ProcessEnv;
  context: Context;
  deadlineMs: number;
  fresh: () => Promise<void>;
  reuse: () => Promise<void>;
}

export async function prepareTree(
  input: TreePreparation,
): Promise<{ source: TreeSource }> {
  const { pool, target, context } = input;
  const clone = async () => {
    await input.fresh();
    return { source: TreeSource.Clone };
  };
  if (!pool.take(input, target, input.nodeId)) return await clone();
  let reused = false;
  try {
    const state = await normaliseGitState(
      {
        env: input.env,
        directory: target,
        context,
        deadlineMs: input.deadlineMs,
      },
      input.address,
      input.keepRefs,
    );
    if (state === GitState.Ready) {
      await input.reuse();
      reused = true;
    }
  } catch (error) {
    if (context.signal.aborted) throw error;
  }
  if (reused) return { source: TreeSource.Pool };
  pool.remove(target);
  return await clone();
}
