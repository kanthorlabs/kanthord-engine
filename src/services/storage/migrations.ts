import type { Migration } from "./migration.ts";
import { coreEntities } from "./migration-0001-core-entities.ts";
import { graphAndPlan } from "./migration-0002-graph-and-plan.ts";
import { executionAndJournal } from "./migration-0003-execution-and-journal.ts";

export const migrations: readonly Migration[] = [
  coreEntities,
  graphAndPlan,
  executionAndJournal,
];
