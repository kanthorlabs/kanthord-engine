import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";

const FILE_NOT_FOUND = "ENOENT";
const NOT_A_DIRECTORY = "ENOTDIR";
const SINGLE_LINK = 1;
const ENTRIES_PER_TURN = 256;
const TURN_BOUNDARY = 0;

export interface WalkTotal {
  readonly files: number;
  readonly bytes: number;
  readonly oldest_at: number | null;
  readonly newest_at: number | null;
}

export interface WalkOptions {
  readonly skip?: readonly string[];
  readonly seen?: Set<string>;
  readonly signal?: AbortSignal;
}

function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === FILE_NOT_FOUND || code === NOT_A_DIRECTORY;
}

function skipped(root: string, path: string, skip: readonly string[]): boolean {
  const name = relative(root, path).split(sep).join("/");
  return skip.includes(name);
}

interface FootprintTally {
  files: number;
  bytes: number;
  oldest: number | null;
  newest: number | null;
}

interface WalkState {
  readonly pending: string[];
  readonly seen: Set<string>;
  visited: number;
}

async function lstatPresent(path: string): Promise<BigIntStats | null> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
}

async function queueChildren(path: string, pending: string[]): Promise<void> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    if (absent(error)) return;
    throw error;
  }
  for (const name of names) pending.push(join(path, name));
}

function seenBefore(stats: BigIntStats, seen: Set<string>): boolean {
  if (stats.nlink <= SINGLE_LINK) return false;
  const identity = `${stats.dev}:${stats.ino}`;
  if (seen.has(identity)) return true;
  seen.add(identity);
  return false;
}

async function countableFile(
  path: string,
  state: WalkState,
): Promise<BigIntStats | null> {
  const stats = await lstatPresent(path);
  if (stats === null) return null;
  if (++state.visited % ENTRIES_PER_TURN === TURN_BOUNDARY) await yieldTurn();
  if (stats.isDirectory()) {
    await queueChildren(path, state.pending);
    return null;
  }
  return seenBefore(stats, state.seen) ? null : stats;
}

function tallyFile(tally: FootprintTally, stats: BigIntStats): void {
  const modified = Number(stats.mtimeMs);
  tally.files += 1;
  tally.bytes += Number(stats.size);
  tally.oldest =
    tally.oldest === null ? modified : Math.min(tally.oldest, modified);
  tally.newest =
    tally.newest === null ? modified : Math.max(tally.newest, modified);
}

export async function walkFootprint(
  root: string,
  options: WalkOptions = {},
): Promise<WalkTotal> {
  const skip = options.skip ?? [];
  const state: WalkState = {
    pending: [root],
    seen: options.seen ?? new Set<string>(),
    visited: 0,
  };
  const tally: FootprintTally = {
    files: 0,
    bytes: 0,
    oldest: null,
    newest: null,
  };
  while (state.pending.length) {
    options.signal?.throwIfAborted();
    const path = state.pending.pop()!;
    if (path !== root && skipped(root, path, skip)) continue;
    const stats = await countableFile(path, state);
    if (stats !== null) tallyFile(tally, stats);
  }
  return {
    files: tally.files,
    bytes: tally.bytes,
    oldest_at: tally.oldest,
    newest_at: tally.newest,
  };
}
