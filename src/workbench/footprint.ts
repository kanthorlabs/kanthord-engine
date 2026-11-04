import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkFootprint } from "../kernel/footprint-walk.ts";
import { PI_DIRECTORY_NAME } from "../agent/pi.ts";
import {
  type CandidatePage,
  failedMeasure,
  FootprintKind,
  type FootprintMeasure,
  type FootprintOwner,
  itemsMeasure,
  type MeasuredItem,
  TOOL_OUTPUT_NAME_PATTERN,
} from "../footprint/contract.ts";
import { WORKBENCH_DIRECTORY_NAME } from "./contract.ts";

const SESSIONS_DIRECTORY_NAME = "sessions";
const FILE_NOT_FOUND = "ENOENT";
const SINGLE_LINK = 1n;
const WORKBENCH_UNMEASURED = "workbench.footprint.unmeasured";

export interface WorkbenchFootprintDependencies {
  readonly stateDirectory: string;
  readonly device: () => Promise<string>;
  readonly temporaryDirectory?: string;
  readonly now?: () => number;
}

async function namesOf(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND) return [];
    throw error;
  }
}

async function sessionFiles(
  root: string,
  seen: Set<string>,
  signal: AbortSignal,
): Promise<MeasuredItem[]> {
  const items: MeasuredItem[] = [];
  const pending = [root];
  while (pending.length) {
    signal.throwIfAborted();
    const directory = pending.pop()!;
    for (const name of await namesOf(directory)) {
      const path = join(directory, name);
      const stats = await lstat(path, { bigint: true });
      if (stats.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!stats.isFile()) continue;
      if (stats.nlink > SINGLE_LINK) {
        const identity = `${stats.dev}:${stats.ino}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
      }
      items.push({ bytes: Number(stats.size), at: Number(stats.mtimeMs) });
    }
  }
  return items;
}

export class WorkbenchFootprint implements FootprintOwner {
  readonly kinds: readonly FootprintKind[] = [FootprintKind.Workbench];
  private readonly dependencies: WorkbenchFootprintDependencies;

  constructor(dependencies: WorkbenchFootprintDependencies) {
    this.dependencies = dependencies;
  }

  async measure(signal: AbortSignal): Promise<FootprintMeasure[]> {
    const { stateDirectory } = this.dependencies;
    const now = (this.dependencies.now ?? Date.now)();
    try {
      const seen = new Set<string>();
      const items = await sessionFiles(
        join(
          stateDirectory,
          PI_DIRECTORY_NAME,
          SESSIONS_DIRECTORY_NAME,
          WORKBENCH_DIRECTORY_NAME,
        ),
        seen,
        signal,
      );
      const agents = join(stateDirectory, WORKBENCH_DIRECTORY_NAME);
      for (const agent of await namesOf(agents)) {
        const total = await walkFootprint(join(agents, agent), {
          seen,
          signal,
        });
        items.push({ bytes: total.bytes, at: total.newest_at ?? now });
      }
      const temporary = this.dependencies.temporaryDirectory ?? tmpdir();
      for (const name of await namesOf(temporary)) {
        if (!TOOL_OUTPUT_NAME_PATTERN.test(name)) continue;
        const stats = await lstat(join(temporary, name));
        if (!stats.isFile()) continue;
        items.push({ bytes: stats.size, at: Math.floor(stats.mtimeMs) });
      }
      return [
        itemsMeasure(FootprintKind.Workbench, items, now, {
          device: await this.dependencies.device(),
        }),
      ];
    } catch (error) {
      return [
        failedMeasure(
          FootprintKind.Workbench,
          WORKBENCH_UNMEASURED,
          error instanceof Error ? error.message : String(error),
        ),
      ];
    }
  }

  candidates(): Promise<CandidatePage> {
    return Promise.resolve({ items: [], total_count: 0, total_bytes: 0 });
  }
}
