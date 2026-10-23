import assert from "node:assert/strict";
import { digest } from "../../kernel/json.ts";
import type { TaskContent } from "../../mission/contract.ts";
import { amendTrailer, headCommit, trailerValues } from "./local-git.ts";
import { repositoryOf, type StepsState } from "./steps-implement.ts";
import { withinCleanup } from "./verdict-rule.ts";

export const DONE_TRAILER = "Kanthord-Done";
const NO_CHECKOUTS = 0;

export function doneRecordOf(unit: TaskContent): string {
  assert.ok(unit.id);
  return `${unit.id} ${digest(unit.content)}`;
}

export function doneTrailerOf(unit: TaskContent): string {
  return `${DONE_TRAILER}: ${doneRecordOf(unit)}`;
}

export function isDone(
  records: ReadonlySet<string>,
  unit: TaskContent,
): boolean {
  return records.has(doneRecordOf(unit));
}

export async function readDoneRecords(
  state: StepsState,
): Promise<ReadonlySet<string>> {
  return withinCleanup(state, async (context, remaining) => {
    const records = new Set<string>();
    for (const checkout of state.checkouts)
      for (const record of await trailerValues(
        state.input.env,
        checkout.directory,
        DONE_TRAILER,
        `origin/${repositoryOf(state, checkout).strategy.base_branch}`,
        context,
        remaining(),
      ))
        records.add(record);
    return records;
  });
}

export async function writeDoneRecord(
  state: StepsState,
  unit: TaskContent,
  commits: ReadonlySet<string>,
): Promise<boolean> {
  const held = state.checkouts.filter((checkout) => commits.has(checkout.head));
  if (held.length === NO_CHECKOUTS) {
    state.run.log("done record skipped", { task_id: unit.id });
    return false;
  }
  await withinCleanup(state, async (context, remaining) => {
    for (const checkout of held) {
      await amendTrailer(
        state.input.env,
        checkout.directory,
        doneTrailerOf(unit),
        context,
        remaining(),
      );
      checkout.head = await headCommit(
        state.input.env,
        checkout.directory,
        context,
        remaining(),
      );
    }
  });
  state.run.log("done recorded", {
    task_id: unit.id,
    commits: held.map((checkout) => checkout.head),
  });
  return true;
}
