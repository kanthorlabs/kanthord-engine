import { HttpStatus } from "../kernel/http.ts";
import {
  OperationResultType,
  type ClientOptions,
  type OperationResult,
} from "../kernel/operation.ts";
import {
  MissionErrorCode,
  NodeState,
  type Revision,
  type Assessment,
  type ExecutionObjective,
} from "../mission/contract.ts";
import { EndReason, ExecutionRun } from "./execution-run.ts";
import { NodeKind } from "./native-agent.ts";

export const READ_PAGE_LIMIT = 1000;
const FIRST_ATTEMPT = 1;
export const TERMINAL_STATES: readonly NodeState[] = [
  NodeState.Completed,
  NodeState.Discarded,
];

export async function readAllPages<T>(
  run: ExecutionRun,
  read: (
    cursor: string | null,
    options: ClientOptions,
  ) => Promise<OperationResult<{ items: T[]; next_cursor: string | null }>>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < READ_PAGE_LIMIT; page++) {
    const answer = await run.call((options) => read(cursor, options));
    items.push(...answer.items);
    cursor = answer.next_cursor;
    if (cursor === null) return items;
  }
  return run.stop(EndReason.OperationFailed);
}

export function readPinnedRevision(run: ExecutionRun) {
  return run.call((options) =>
    run.clients.mission["execution.pinnedRevision.get"](
      {
        params: { execution_id: run.claim.execution_id },
        query: {},
        body: null,
      },
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
        params: { execution_id: run.claim.execution_id },
        query: cursor === null ? {} : { cursor },
        body: null,
      },
      options,
    ),
  );
}

export async function readObjectives(run: ExecutionRun) {
  const input = (cursor: string | null) => ({
    params: { execution_id: run.claim.execution_id },
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

function nullOnRecordNotFound(
  result: OperationResult<Assessment>,
): OperationResult<Assessment | null> {
  if (
    result.type === OperationResultType.Failure &&
    result.status === HttpStatus.NotFound &&
    result.error.error.code === MissionErrorCode.RecordNotFound
  )
    return {
      type: OperationResultType.Completed,
      status: HttpStatus.OK,
      data: null,
    };
  return result;
}

export async function readReworkAssessment(run: ExecutionRun) {
  return run.call(async (options) =>
    nullOnRecordNotFound(
      await run.clients.mission["execution.reworkAssessment.get"](
        {
          params: { execution_id: run.claim.execution_id },
          query: {},
          body: null,
        },
        options,
      ),
    ),
  );
}

export async function readClearedAssessment(run: ExecutionRun) {
  if (run.claim.attempt === FIRST_ATTEMPT) return null;
  return run.call(async (options) =>
    nullOnRecordNotFound(
      await run.clients.mission["execution.clearedAssessment.get"](
        {
          params: { execution_id: run.claim.execution_id },
          query: {},
          body: null,
        },
        options,
      ),
    ),
  );
}

export async function readPriorRationale(run: ExecutionRun) {
  const assessment =
    (await readReworkAssessment(run)) ?? (await readClearedAssessment(run));
  return assessment?.rationale ?? null;
}

export function allTerminal(
  objectives: readonly ExecutionObjective[],
): boolean {
  return objectives.every((objective) =>
    TERMINAL_STATES.includes(objective.state),
  );
}
