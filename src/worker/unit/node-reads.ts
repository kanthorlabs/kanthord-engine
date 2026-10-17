import { HttpStatus } from "../../kernel/http.ts";
import {
  OperationResultType,
  type ClientOptions,
  type OperationResult,
} from "../../kernel/operation.ts";
import {
  ClosingEvent,
  MissionErrorCode,
  type Assessment,
  type Outcome,
} from "../../mission/contract.ts";
import { requestedChangesText } from "./judgement.ts";
import { EndReason, ExecutionRun } from "./execution-run.ts";

export const READ_PAGE_LIMIT = 1000;
const FIRST_ATTEMPT = 1;

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

export async function readDependencies(run: ExecutionRun) {
  const input = (cursor: string | null) => ({
    params: { execution_id: run.claim.execution_id },
    query: cursor === null ? {} : { cursor },
    body: null,
  });
  const dependencies = await readAllPages(run, (cursor, options) =>
    run.clients.mission["execution.dependency.list"](input(cursor), options),
  );
  const outcomes = await readAllPages(run, (cursor, options) =>
    run.clients.mission["execution.dependency.outcome.list"](
      input(cursor),
      options,
    ),
  );
  const evidence = await readAllPages(run, (cursor, options) =>
    run.clients.mission["execution.dependency.evidence.list"](
      input(cursor),
      options,
    ),
  );
  return { dependencies, outcomes, evidence };
}

function nullOnRecordNotFound<T extends Assessment | Outcome>(
  result: OperationResult<T>,
): OperationResult<T | null> {
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
      await run.clients.mission["execution.rework_assessment.get"](
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
      await run.clients.mission["execution.cleared_assessment.get"](
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

export async function readClearedOutcome(run: ExecutionRun) {
  if (run.claim.attempt === FIRST_ATTEMPT) return null;
  return run.call(async (options) =>
    nullOnRecordNotFound(
      await run.clients.mission["execution.clearedOutcome.get"](
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

export async function readRequestedChanges(run: ExecutionRun) {
  const outcome = await readClearedOutcome(run);
  if (outcome?.closing_event !== ClosingEvent.ExternalFailed) return null;
  const read = await run.call((options) =>
    run.clients.worker["execution.change_request.get"](
      {
        params: { execution_id: run.claim.execution_id },
        query: {},
        body: null,
      },
      options,
    ),
  );
  return requestedChangesText(read.items);
}

export interface PriorRationale {
  rationale: string | null;
  rework: boolean;
}

export async function readPriorRationale(
  run: ExecutionRun,
): Promise<PriorRationale> {
  const rework = await readReworkAssessment(run);
  if (rework) return { rationale: rework.rationale, rework: true };
  const requested = await readRequestedChanges(run);
  if (requested !== null) return { rationale: requested, rework: false };
  return {
    rationale: (await readClearedAssessment(run))?.rationale ?? null,
    rework: false,
  };
}
