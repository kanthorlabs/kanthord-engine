import type { ClientOptions, OperationResult } from "../kernel/operation.ts";
import {
  NodeState,
  type Revision,
  type ExecutionObjective,
} from "../mission/contract.ts";
import { EndReason, ExecutionRun } from "./execution-run.ts";
import { NodeKind } from "./native-agent.ts";

export const READ_PAGE_LIMIT = 1000;
export const TERMINAL_STATES: readonly NodeState[] = [
  NodeState.Completed,
  NodeState.Discarded,
];
const FIRST_ATTEMPT = 1;

export async function readAllPages<T>(
  run: ExecutionRun,
  read: (
    cursor: string | null,
    options: ClientOptions,
  ) => Promise<OperationResult<{ items: T[]; nextCursor: string | null }>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < READ_PAGE_LIMIT; page++) {
    const answer = await run.call((options) => read(cursor, options));
    items.push(...answer.items);
    cursor = answer.nextCursor;
    if (cursor === null) return items;
  }
  return run.stop(EndReason.OperationFailed);
}

export function readPinnedRevision(run: ExecutionRun) {
  return run.call((options) =>
    run.clients.mission["execution.pinnedRevision.get"](
      { params: { executionId: run.claim.executionId }, query: {}, body: null },
      options,
    ),
  );
}

export function nodeKindOf(revision: Pick<Revision, "tasks">): NodeKind {
  return revision.tasks === undefined
    ? NodeKind.Initiative
    : NodeKind.Objective;
}

export function readAttemptEvidence(run: ExecutionRun) {
  return readAllPages(run, (cursor, options) =>
    run.clients.mission["execution.evidence.list"](
      {
        params: { executionId: run.claim.executionId },
        query: cursor === null ? {} : { cursor },
        body: null,
      },
      options,
    ),
  );
}

export async function readObjectives(run: ExecutionRun) {
  const input = (cursor: string | null) => ({
    params: { executionId: run.claim.executionId },
    query: cursor === null ? {} : { cursor },
    body: null,
  });
  const objectives = await readAllPages(run, (cursor, options) =>
    run.clients.mission["execution.objective.list"](input(cursor), options),
  );
  const outcomes = await readAllPages(run, (cursor, options) =>
    run.clients.mission["execution.objective.outcome.list"](
      input(cursor),
      options,
    ),
  );
  const evidence = await readAllPages(run, (cursor, options) =>
    run.clients.mission["execution.objective.evidence.list"](
      input(cursor),
      options,
    ),
  );
  return { objectives, outcomes, evidence };
}

export async function readClearedOutcome(run: ExecutionRun) {
  if (run.claim.attempt === FIRST_ATTEMPT) return null;
  return run.call((options) =>
    run.clients.mission["execution.clearedOutcome.get"](
      { params: { executionId: run.claim.executionId }, query: {}, body: null },
      options,
    ),
  );
}

export function allTerminal(
  objectives: readonly ExecutionObjective[],
): boolean {
  return objectives.every((objective) =>
    TERMINAL_STATES.includes(objective.state),
  );
}
