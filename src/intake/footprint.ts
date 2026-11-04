import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { walkFootprint } from "../kernel/footprint-walk.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  type CandidatePage,
  failedMeasure,
  FootprintKind,
  type FootprintMeasure,
  type FootprintOwner,
  itemsMeasure,
  type MeasuredItem,
} from "../footprint/contract.ts";

const INTAKE_STATE_DIRECTORY = "intake";
const REPOSITORIES_DIRECTORY = "repositories";
const BARE_REPOSITORY_SUFFIX = ".git";
const FILE_NOT_FOUND = "ENOENT";
const MIRROR_UNMEASURED = "intake.footprint.unmeasured";

export interface IntakeFootprintDependencies {
  readonly stateDirectory: string;
  readonly device: () => Promise<string>;
  readonly now?: () => number;
}

export function oldestInboundEvent(tx: Transaction): number | null {
  const row = tx.database
    .prepare("SELECT MIN(created_at) AS oldest FROM intake_inbound_event")
    .get() as { oldest: number | null };
  return row.oldest;
}

export class IntakeFootprint implements FootprintOwner {
  readonly kinds: readonly FootprintKind[] = [FootprintKind.IntakeMirror];
  private readonly dependencies: IntakeFootprintDependencies;

  constructor(dependencies: IntakeFootprintDependencies) {
    this.dependencies = dependencies;
  }

  private root(): string {
    return join(
      this.dependencies.stateDirectory,
      INTAKE_STATE_DIRECTORY,
      REPOSITORIES_DIRECTORY,
    );
  }

  async measure(signal: AbortSignal): Promise<FootprintMeasure[]> {
    const now = (this.dependencies.now ?? Date.now)();
    try {
      let names: string[];
      try {
        names = await readdir(this.root());
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== FILE_NOT_FOUND)
          throw error;
        names = [];
      }
      const seen = new Set<string>();
      const items: MeasuredItem[] = [];
      for (const name of names.filter((entry) =>
        entry.endsWith(BARE_REPOSITORY_SUFFIX),
      )) {
        const total = await walkFootprint(join(this.root(), name), {
          seen,
          signal,
        });
        items.push({ bytes: total.bytes, at: total.newest_at ?? now });
      }
      return [
        itemsMeasure(FootprintKind.IntakeMirror, items, now, {
          device: await this.dependencies.device(),
        }),
      ];
    } catch (error) {
      return [
        failedMeasure(
          FootprintKind.IntakeMirror,
          MIRROR_UNMEASURED,
          error instanceof Error ? error.message : String(error),
        ),
      ];
    }
  }

  candidates(): Promise<CandidatePage> {
    return Promise.resolve({ items: [], total_count: 0, total_bytes: 0 });
  }
}
