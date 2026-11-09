import { lstat, readdir, rm, stat, statfs } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  CleanupRefusal,
  type CleanupRefused,
  FOOTPRINT_REPORT_ITEMS_MAX,
  InstanceCleanableKind,
  InstanceFootprintKind,
  TOOL_OUTPUT_NAME_PATTERN,
  WORKSPACE_KEY_PATTERN,
} from "../../kernel/cleanup.ts";
import { FILE_NOT_FOUND } from "../../kernel/files.ts";
import { walkFootprint } from "../../kernel/footprint-walk.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { DAY_MS, DEFAULT_AGE_DAYS } from "../../footprint/contract.ts";
import {
  type FootprintItem,
  type FootprintKindMeasure,
  type FootprintMeasurement,
  type FootprintOrder,
  type FootprintResult,
  SessionRemoval,
} from "../contract.ts";
import {
  executionSessionItems,
  removeExecutionSession,
  sessionRootOf,
} from "./session-store.ts";
import { POOL_DIRECTORY } from "./tree-pool.ts";
import {
  WorkspaceRemoval,
  type WorkspaceRoot,
  WORKSPACES_DIRECTORY,
} from "./workspace.ts";

const UNIT_LOG_PATTERN = /^kanthord\.log(\..+)?$/;
const CACHE_DIRECTORY = ".cache";
const STDERR_LOG = "stderr.log";
const SLOT_COUNT = 1;
const NO_BYTES = 0;
const NO_ITEMS = 0;

export interface UnitFootprintDevice {
  stat(path: string): Promise<{ dev: number | bigint }>;
  statfs(
    path: string,
  ): Promise<{ blocks: number; bsize: number; bavail: number }>;
}

export interface UnitFootprintOptions {
  readonly data: string;
  readonly logDirectory: string;
  readonly temporary: string;
  readonly residueRoot: string;
  readonly workerPlacement: boolean;
  readonly workspaces: WorkspaceRoot;
  readonly runningSince: () => number | null;
  readonly liveExecutions: () => readonly string[];
  readonly device?: UnitFootprintDevice;
  readonly now?: () => number;
}

interface Tally {
  removed: string[];
  removed_bytes: number;
  absent: string[];
  refused: CleanupRefused[];
}

const systemDevice: UnitFootprintDevice = {
  stat: (path) => stat(path),
  statfs: (path) => statfs(path),
};

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === FILE_NOT_FOUND;
}

async function namesOf(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

function oldestFirst(a: FootprintItem, b: FootprintItem): number {
  return a.modified_at - b.modified_at || a.key.localeCompare(b.key);
}

function relativeName(root: string, path: string): string | null {
  const name = relative(root, path);
  if (!name || name.startsWith("..")) return null;
  return name.split(sep).join("/");
}

export class UnitFootprint {
  private readonly options: UnitFootprintOptions;
  private readonly device: UnitFootprintDevice;
  private readonly now: () => number;
  private readonly running = new Set<string>();

  constructor(options: UnitFootprintOptions) {
    this.options = options;
    this.device = options.device ?? systemDevice;
    this.now = options.now ?? Date.now;
  }

  private kindMeasure(
    kind: InstanceFootprintKind,
    items: FootprintItem[],
    listed: boolean,
  ): FootprintKindMeasure {
    const sorted = [...items].sort(oldestFirst);
    const since = this.now() - DEFAULT_AGE_DAYS * DAY_MS;
    return {
      kind,
      count: sorted.length,
      bytes: sorted.reduce((sum, item) => sum + item.bytes, NO_BYTES),
      oldest_at: sorted.at(0)?.modified_at ?? null,
      newest_at: sorted.at(-1)?.modified_at ?? null,
      recent_count: sorted.filter((item) => item.modified_at >= since).length,
      items: listed ? sorted.slice(0, FOOTPRINT_REPORT_ITEMS_MAX) : [],
      items_complete: !listed || sorted.length <= FOOTPRINT_REPORT_ITEMS_MAX,
    };
  }

  private sessionRoot(): string {
    return sessionRootOf(this.options.data);
  }

  private workspaceRoot(): string {
    return join(this.options.data, WORKSPACES_DIRECTORY);
  }

  private async workspaceItems(signal: AbortSignal): Promise<FootprintItem[]> {
    const root = this.workspaceRoot();
    const items: FootprintItem[] = [];
    const seen = new Set<string>();
    for (const name of await namesOf(root)) {
      signal.throwIfAborted();
      if (!WORKSPACE_KEY_PATTERN.test(name)) continue;
      const path = join(root, name);
      const stats = await lstat(path).catch(() => null);
      if (!stats?.isDirectory()) continue;
      const total = await walkFootprint(path, { seen, signal });
      items.push({
        key: name,
        bytes: total.bytes,
        modified_at: Math.floor(stats.mtimeMs),
      });
    }
    const trees = this.options.workspaces.pool.trees();
    if (trees.length > NO_ITEMS)
      items.push({
        key: POOL_DIRECTORY,
        bytes: (
          await walkFootprint(this.options.workspaces.pool.root, {
            seen,
            signal,
          })
        ).bytes,
        modified_at: Math.max(...trees.map((tree) => tree.returned_at)),
      });
    return items;
  }

  private async toolOutputItems(): Promise<FootprintItem[]> {
    const items: FootprintItem[] = [];
    for (const name of await namesOf(this.options.temporary)) {
      if (!TOOL_OUTPUT_NAME_PATTERN.test(name)) continue;
      const stats = await lstat(join(this.options.temporary, name)).catch(
        () => null,
      );
      if (!stats?.isFile()) continue;
      items.push({
        key: name,
        bytes: stats.size,
        modified_at: Math.floor(stats.mtimeMs),
      });
    }
    return items;
  }

  private async logItems(): Promise<FootprintItem[]> {
    const items: FootprintItem[] = [];
    for (const name of await namesOf(this.options.logDirectory)) {
      if (!UNIT_LOG_PATTERN.test(name)) continue;
      const stats = await lstat(join(this.options.logDirectory, name)).catch(
        () => null,
      );
      if (!stats?.isFile()) continue;
      items.push({
        key: name,
        bytes: stats.size,
        modified_at: Math.floor(stats.mtimeMs),
      });
    }
    return items;
  }

  private async residue(
    toolOutputs: readonly FootprintItem[],
    logs: readonly FootprintItem[],
    signal: AbortSignal,
  ): Promise<FootprintKindMeasure> {
    const root = this.options.residueRoot;
    const skipped = [
      this.sessionRoot(),
      this.workspaceRoot(),
      join(root, CACHE_DIRECTORY),
      join(root, STDERR_LOG),
      ...logs.map((item) => join(this.options.logDirectory, item.key)),
      ...toolOutputs.map((item) => join(this.options.temporary, item.key)),
    ];
    const skip = skipped.flatMap((path) => {
      const name = relativeName(root, path);
      return name === null ? [] : [name];
    });
    const total = await walkFootprint(root, { skip, signal });
    return {
      kind: InstanceFootprintKind.SlotResidue,
      count: SLOT_COUNT,
      bytes: total.bytes,
      oldest_at: total.oldest_at === null ? null : Math.floor(total.oldest_at),
      newest_at: total.newest_at === null ? null : Math.floor(total.newest_at),
      recent_count: NO_ITEMS,
      items: [],
      items_complete: true,
    };
  }

  private async disk(): Promise<FootprintMeasurement["disk"]> {
    const unit = this.options.data;
    const [identity, space] = await Promise.all([
      this.device.stat(unit),
      this.device.statfs(unit),
    ]);
    return {
      device: String(identity.dev),
      total_bytes: space.blocks * space.bsize,
      free_bytes: space.bavail * space.bsize,
    };
  }

  async measure(signal: AbortSignal): Promise<FootprintMeasurement> {
    const measuredAt = this.now();
    const toolOutputs = await this.toolOutputItems();
    const logs = await this.logItems();
    const kinds: FootprintKindMeasure[] = [];
    if (this.options.workerPlacement)
      kinds.push(
        this.kindMeasure(
          InstanceFootprintKind.Session,
          await executionSessionItems(this.sessionRoot(), signal),
          true,
        ),
      );
    kinds.push(
      this.kindMeasure(
        InstanceFootprintKind.Workspace,
        await this.workspaceItems(signal),
        true,
      ),
      this.kindMeasure(InstanceFootprintKind.ToolOutput, toolOutputs, true),
      this.kindMeasure(InstanceFootprintKind.Log, logs, true),
      await this.residue(toolOutputs, logs, signal),
    );
    return {
      measured_at: measuredAt,
      disk: this.options.workerPlacement ? await this.disk() : null,
      kinds,
    };
  }

  async run(
    order: FootprintOrder,
    signal: AbortSignal,
  ): Promise<FootprintResult | null> {
    if (this.running.has(order.cleanup_id)) return null;
    this.running.add(order.cleanup_id);
    try {
      const tally: Tally = {
        removed: [],
        removed_bytes: NO_BYTES,
        absent: [],
        refused: [],
      };
      for (const key of order.keys) {
        signal.throwIfAborted();
        await this.remove(order.kind, key, tally, signal);
      }
      return { cleanup_id: order.cleanup_id, ...tally };
    } finally {
      this.running.delete(order.cleanup_id);
    }
  }

  private async remove(
    kind: InstanceCleanableKind,
    key: string,
    tally: Tally,
    signal: AbortSignal,
  ): Promise<void> {
    if (kind === InstanceCleanableKind.Session)
      return this.removeSession(key, tally, signal);
    if (kind === InstanceCleanableKind.Workspace)
      return this.removeWorkspace(key, tally, signal);
    return this.removeToolOutput(key, tally);
  }

  private refuse(tally: Tally, key: string, reason: CleanupRefusal): void {
    tally.refused.push({ key, reason });
  }

  private async removeSession(
    key: string,
    tally: Tally,
    signal: AbortSignal,
  ): Promise<void> {
    if (!identitySchema("execution").safeParse(key).success)
      return this.refuse(tally, key, CleanupRefusal.Unreadable);
    if (this.options.liveExecutions().includes(key))
      return this.refuse(tally, key, CleanupRefusal.Live);
    const result = await removeExecutionSession(
      this.sessionRoot(),
      key,
      signal,
    );
    if (result.removal === SessionRemoval.Removed) {
      tally.removed.push(key);
      tally.removed_bytes += result.bytes;
    } else if (result.removal === SessionRemoval.Absent) tally.absent.push(key);
    else this.refuse(tally, key, CleanupRefusal.Unreadable);
  }

  private async removeWorkspace(
    key: string,
    tally: Tally,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.options.workspaces.removeWorkspace(key, signal);
    if (result.removal === WorkspaceRemoval.Removed) {
      tally.removed.push(key);
      tally.removed_bytes += result.bytes;
    } else if (result.removal === WorkspaceRemoval.Absent)
      tally.absent.push(key);
    else
      this.refuse(
        tally,
        key,
        result.removal === WorkspaceRemoval.Live
          ? CleanupRefusal.Live
          : CleanupRefusal.Unreadable,
      );
  }

  private async removeToolOutput(key: string, tally: Tally): Promise<void> {
    if (!TOOL_OUTPUT_NAME_PATTERN.test(key))
      return this.refuse(tally, key, CleanupRefusal.Unreadable);
    const path = join(this.options.temporary, key);
    const stats = await lstat(path).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!stats) {
      tally.absent.push(key);
      return;
    }
    if (!stats.isFile())
      return this.refuse(tally, key, CleanupRefusal.Unreadable);
    const since = this.options.runningSince();
    if (since !== null && stats.mtimeMs >= since)
      return this.refuse(tally, key, CleanupRefusal.Live);
    await rm(path, { force: true });
    tally.removed.push(key);
    tally.removed_bytes += stats.size;
  }
}
