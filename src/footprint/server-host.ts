import { lstat, readdir, stat, statfs, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { Store } from "../kernel/store.ts";
import {
  BACKUP_NAME_PATTERN,
  type CandidatePage,
  type CandidateQuery,
  CleanupRule,
  DAY_MS,
  DEFAULT_AGE_DAYS,
  emptyMeasure,
  failedMeasure,
  FOOTPRINT_SCAN_BUDGET_MS,
  type FootprintCandidate,
  FootprintKind,
  type FootprintMeasure,
  type FootprintOwner,
  type FootprintTable,
  olderThanCutoff,
} from "./contract.ts";

const BACKUP_SEPARATOR = ".bak-";
const WAL_SUFFIX = "-wal";
const SERVER_LOG_NAME = "kanthord.log";
const FILE_NOT_FOUND = "ENOENT";
const DATA_DIRECTORY_LABEL = "data_directory";
const STATE_DIRECTORY_LABEL = "state_directory";

export const ServerHostErrorCode = {
  DatabaseUnmeasured: "footprint.database.unmeasured",
  BackupUnmeasured: "footprint.backup.unmeasured",
  LogUnmeasured: "footprint.log.unmeasured",
  DiskUnmeasured: "footprint.disk.unmeasured",
} as const;

export interface BreakdownRow {
  readonly delete_operation: string | null;
  readonly oldest_at?: () => number | null;
}

export interface ServerHostDependencies {
  readonly store: Store;
  readonly databasePath: string;
  readonly trackingDatabasePath: string;
  readonly configPath: string;
  readonly stateDirectory: string;
  readonly breakdownRows: Readonly<Record<string, BreakdownRow>>;
  readonly now?: () => number;
}

interface BackupFile {
  readonly name: string;
  readonly path: string;
  readonly base: string;
  readonly bytes: number;
  readonly at: number;
}

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === FILE_NOT_FOUND;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function deviceKey(path: string): Promise<string> {
  return String((await stat(path, { bigint: true })).dev);
}

export async function fileBytes(path: string): Promise<number> {
  try {
    return (await lstat(path)).size;
  } catch (error) {
    if (isAbsent(error)) return 0;
    throw error;
  }
}

export async function breakdown(
  store: Store,
  rows: Readonly<Record<string, BreakdownRow>>,
  signal: AbortSignal,
): Promise<FootprintTable[]> {
  const started = performance.now();
  const tables: FootprintTable[] = [];
  for (const name of store.tableNames()) {
    signal.throwIfAborted();
    const row = rows[name];
    const inBudget = performance.now() - started < FOOTPRINT_SCAN_BUDGET_MS;
    tables.push({
      name,
      bytes: inBudget ? store.treeBytes(name) : null,
      oldest_at: row?.oldest_at?.() ?? null,
      delete_operation: row?.delete_operation ?? null,
    });
    await yieldTurn();
  }
  return tables;
}

export class ServerHost implements FootprintOwner {
  readonly kinds: readonly FootprintKind[] = [
    FootprintKind.OperationalDatabase,
    FootprintKind.DatabaseBackup,
    FootprintKind.Log,
    FootprintKind.Disk,
  ];
  private readonly dependencies: ServerHostDependencies;
  private readonly now: () => number;
  private readonly devices = new Map<string, string>();

  constructor(dependencies: ServerHostDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? Date.now;
  }

  private get dataDirectory(): string {
    return dirname(this.dependencies.databasePath);
  }

  private backupBases(): ReadonlyMap<string, string> {
    const { databasePath, trackingDatabasePath, configPath } =
      this.dependencies;
    return new Map([
      [basename(databasePath), dirname(databasePath)],
      [basename(trackingDatabasePath), dirname(trackingDatabasePath)],
      [basename(configPath), dirname(configPath)],
    ]);
  }

  async measure(): Promise<FootprintMeasure[]> {
    return [
      await this.measureDatabase(),
      await this.measureBackups(),
      await this.measureLog(),
      ...(await this.measureDisks()),
    ];
  }

  private async measureDatabase(): Promise<FootprintMeasure> {
    const kind = FootprintKind.OperationalDatabase;
    try {
      const { store, databasePath } = this.dependencies;
      const pages = store.pages();
      return emptyMeasure(kind, {
        device: await deviceKey(this.dataDirectory),
        count: store.tableNames().length,
        bytes: (pages.page_count - pages.freelist_count) * pages.page_size,
        free_bytes: pages.freelist_count * pages.page_size,
        wal_bytes: await fileBytes(`${databasePath}${WAL_SUFFIX}`),
      });
    } catch (error) {
      return failedMeasure(
        kind,
        ServerHostErrorCode.DatabaseUnmeasured,
        messageOf(error),
      );
    }
  }

  async backups(): Promise<BackupFile[]> {
    const files: BackupFile[] = [];
    const directories = new Set(this.backupBases().values());
    for (const directory of directories) {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if (isAbsent(error)) continue;
        throw error;
      }
      for (const name of names) {
        const base = this.baseOf(name);
        if (base === null || this.backupBases().get(base) !== directory)
          continue;
        const path = join(directory, name);
        const stats = await lstat(path);
        if (!stats.isFile()) continue;
        files.push({
          name,
          path,
          base,
          bytes: stats.size,
          at: Math.floor(stats.mtimeMs),
        });
      }
    }
    return files.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  }

  private baseOf(name: string): string | null {
    if (!BACKUP_NAME_PATTERN.test(name)) return null;
    const base = name.slice(0, name.lastIndexOf(BACKUP_SEPARATOR));
    return this.backupBases().has(base) ? base : null;
  }

  private async measureBackups(): Promise<FootprintMeasure> {
    const kind = FootprintKind.DatabaseBackup;
    try {
      const files = await this.backups();
      const since = this.now() - DEFAULT_AGE_DAYS * DAY_MS;
      return emptyMeasure(kind, {
        device: await deviceKey(this.dataDirectory),
        count: files.length,
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        oldest_at: files.at(0)?.at ?? null,
        newest_at: files.at(-1)?.at ?? null,
        recent_count: files.filter((file) => file.at >= since).length,
      });
    } catch (error) {
      return failedMeasure(
        kind,
        ServerHostErrorCode.BackupUnmeasured,
        messageOf(error),
      );
    }
  }

  private async measureLog(): Promise<FootprintMeasure> {
    const kind = FootprintKind.Log;
    try {
      const path = join(this.dependencies.stateDirectory, SERVER_LOG_NAME);
      return emptyMeasure(kind, {
        item_key: SERVER_LOG_NAME,
        count: 1,
        bytes: await fileBytes(path),
      });
    } catch (error) {
      return failedMeasure(
        kind,
        ServerHostErrorCode.LogUnmeasured,
        messageOf(error),
        { item_key: SERVER_LOG_NAME },
      );
    }
  }

  private async measureDisks(): Promise<FootprintMeasure[]> {
    const measures = new Map<string, FootprintMeasure>();
    for (const [directory, label] of [
      [this.dataDirectory, DATA_DIRECTORY_LABEL],
      [this.dependencies.stateDirectory, STATE_DIRECTORY_LABEL],
    ] as const) {
      const kind = FootprintKind.Disk;
      try {
        const key = await deviceKey(directory);
        this.devices.set(directory, key);
        if (measures.has(key)) continue;
        const space = await statfs(directory);
        measures.set(
          key,
          emptyMeasure(kind, {
            item_key: key,
            total_bytes: space.blocks * space.bsize,
            free_bytes: space.bavail * space.bsize,
          }),
        );
      } catch (error) {
        const key = this.devices.get(directory) ?? label;
        if (measures.has(key)) continue;
        measures.set(
          key,
          failedMeasure(
            kind,
            ServerHostErrorCode.DiskUnmeasured,
            messageOf(error),
            { item_key: key },
          ),
        );
      }
    }
    return [...measures.values()];
  }

  async candidates(query: CandidateQuery): Promise<CandidatePage> {
    const files = await this.backups();
    const newest = new Map<string, BackupFile>();
    for (const file of files) newest.set(file.base, file);
    const kept = new Set([...newest.values()].map((file) => file.name));
    const cutoff = olderThanCutoff(query.rule, query.now);
    const selected = files.filter((file) =>
      query.rule === null
        ? true
        : query.rule.name === CleanupRule.OlderThan &&
          cutoff !== null &&
          file.at < cutoff &&
          !kept.has(file.name),
    );
    const items: FootprintCandidate[] = selected
      .slice(query.offset, query.offset + query.limit)
      .map((file) => ({
        key: file.name,
        at: file.at,
        bytes: file.bytes,
        project_id: null,
        node_id: null,
        execution_id: null,
        refusal: null,
        kept: kept.has(file.name),
      }));
    return {
      items,
      total_count: selected.length,
      total_bytes: selected.reduce((sum, file) => sum + file.bytes, 0),
    };
  }

  tables(kind: FootprintKind, signal: AbortSignal) {
    return kind === FootprintKind.OperationalDatabase
      ? breakdown(
          this.dependencies.store,
          this.dependencies.breakdownRows,
          signal,
        )
      : Promise.resolve(null);
  }

  async deleteBackups(
    names: readonly string[],
  ): Promise<{ removed: number; absent: number; removed_bytes: number }> {
    let removed = 0;
    let absent = 0;
    let removedBytes = 0;
    for (const name of names) {
      const base = this.baseOf(name);
      const directory = base === null ? null : this.backupBases().get(base);
      if (
        directory === undefined ||
        directory === null ||
        basename(name) !== name
      ) {
        absent += 1;
        continue;
      }
      const path = join(directory, name);
      try {
        const stats = await lstat(path);
        if (!stats.isFile()) {
          absent += 1;
          continue;
        }
        await unlink(path);
        removed += 1;
        removedBytes += stats.size;
      } catch (error) {
        if (!isAbsent(error)) throw error;
        absent += 1;
      }
    }
    return { removed, absent, removed_bytes: removedBytes };
  }
}
