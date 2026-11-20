import { digest } from "../../kernel/json.ts";
import type { TaskContent } from "../../mission/contract.ts";
import type { UnitRecord } from "../contract.ts";
import { rangeCommits } from "./local-git.ts";
import type { StepsState } from "./steps-implement.ts";
import { repositoryOf } from "./setup-repository.ts";
import { withinCleanup } from "./verdict-rule.ts";

const NO_TASKS = 0;

export function unitRecordOf(
  state: StepsState,
  unit: TaskContent,
  commits: ReadonlySet<string>,
): UnitRecord | null {
  const held = state.checkouts.filter((checkout) => commits.has(checkout.head));
  if (!held.length) return null;
  return {
    unit_id: unit.id,
    content_digest: digest(unit.content),
    commits: held.map((checkout) => ({
      binding_id: checkout.binding_id,
      commit: checkout.head,
    })),
  };
}

export function recordsUnit(state: StepsState, unit: TaskContent): boolean {
  return (
    state.revision.tasks.length === NO_TASKS ||
    unit.id !== state.input.claim.node_id
  );
}

async function nodeRanges(
  state: StepsState,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  return withinCleanup(state, async (context, remaining) => {
    const ranges = new Map<string, ReadonlySet<string>>();
    for (const checkout of state.checkouts)
      ranges.set(
        checkout.binding_id,
        new Set(
          await rangeCommits(
            state.input.env,
            checkout.directory,
            `origin/${repositoryOf(state, checkout).strategy.base_branch}`,
            context,
            remaining(),
          ),
        ),
      );
    return ranges;
  });
}

function isValid(
  record: UnitRecord,
  units: ReadonlyMap<string, TaskContent>,
  ranges: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const unit = units.get(record.unit_id);
  return (
    unit !== undefined &&
    record.content_digest === digest(unit.content) &&
    record.commits.every(
      ({ binding_id, commit }) => ranges.get(binding_id)?.has(commit) === true,
    )
  );
}

export async function validUnitRecords(
  state: StepsState,
  units: readonly TaskContent[],
): Promise<ReadonlySet<string>> {
  const records = state.input.setup.unit_records;
  if (!records.length) return new Set();
  const ranges = await nodeRanges(state);
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  return new Set(
    records
      .filter((record) => isValid(record, byId, ranges))
      .map((record) => record.unit_id),
  );
}
