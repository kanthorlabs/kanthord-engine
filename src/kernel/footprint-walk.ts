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

export async function walkFootprint(
  root: string,
  options: WalkOptions = {},
): Promise<WalkTotal> {
  const skip = options.skip ?? [];
  const seen = options.seen ?? new Set<string>();
  let files = 0;
  let bytes = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  let visited = 0;
  const pending = [root];
  while (pending.length) {
    options.signal?.throwIfAborted();
    const path = pending.pop()!;
    if (path !== root && skipped(root, path, skip)) continue;
    let stats;
    try {
      stats = await lstat(path, { bigint: true });
    } catch (error) {
      if (absent(error)) continue;
      throw error;
    }
    if (++visited % ENTRIES_PER_TURN === TURN_BOUNDARY) await yieldTurn();
    if (stats.isDirectory()) {
      let names: string[];
      try {
        names = await readdir(path);
      } catch (error) {
        if (absent(error)) continue;
        throw error;
      }
      for (const name of names) pending.push(join(path, name));
      continue;
    }
    if (stats.nlink > SINGLE_LINK) {
      const identity = `${stats.dev}:${stats.ino}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    const modified = Number(stats.mtimeMs);
    files += 1;
    bytes += Number(stats.size);
    oldest = oldest === null ? modified : Math.min(oldest, modified);
    newest = newest === null ? modified : Math.max(newest, modified);
  }
  return { files, bytes, oldest_at: oldest, newest_at: newest };
}
