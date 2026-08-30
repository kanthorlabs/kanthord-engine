import type { Migration } from "./migration.ts";
import { coreEntities } from "./migration-0001-core-entities.ts";
import { graphAndPlan } from "./migration-0002-graph-and-plan.ts";
import { executionAndJournal } from "./migration-0003-execution-and-journal.ts";
import { migration0004EventIndexes } from "./migration-0004-event-indexes.ts";
import { migration0005Actor } from "./migration-0005-actor.ts";
import { migration0006RevisionOrigin } from "./migration-0006-revision-origin.ts";
import { migration0007ExternalExecution } from "./migration-0007-external-execution.ts";
import { migration0008GraphIndexes } from "./migration-0008-graph-indexes.ts";
import { migration0009OneBranch } from "./migration-0009-one-branch.ts";
import { migration0010ProviderLogin } from "./migration-0010-provider-login.ts";

export const migrations: readonly Migration[] = [
  coreEntities,
  graphAndPlan,
  executionAndJournal,
  migration0004EventIndexes,
  migration0005Actor,
  migration0006RevisionOrigin,
  migration0007ExternalExecution,
  migration0008GraphIndexes,
  migration0009OneBranch,
  migration0010ProviderLogin,
];
