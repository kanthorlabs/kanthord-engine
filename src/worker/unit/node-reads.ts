import { HttpStatus } from "../../kernel/http.ts";
import {
  OperationResultType,
  type ClientOptions,
  type OperationResult,
} from "../../kernel/operation.ts";
import {
  AssessmentResult,
  AssetKind,
  ClosingEvent,
  MissionErrorCode,
  type Assessment,
  type Outcome,
  type TestedInput,
} from "../../mission/contract.ts";
import type { ChangeRequest, ChangeRequestRead } from "../contract.ts";
import { requestedChangesText } from "./judgement.ts";
import { EndReason, ExecutionRun } from "./execution-run.ts";

export const READ_PAGE_LIMIT = 1000;
const FIRST_ATTEMPT = 1;
const NO_TIME = "";

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

export async function readRequestedChanges(
  run: ExecutionRun,
  repositories: readonly RepositoryName[],
): Promise<Verdict | null> {
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
  const text = requestedChangesText(
    read.items.map((item) => ({
      ...item,
      binding:
        repositories.find(
          (repository) => repository.binding_id === item.binding_id,
        )?.name ?? item.binding_id,
    })),
  );
  if (text === null) return null;
  return { text, judged: latestRequestCommits(read.items) };
}

function latestRequestCommits(
  items: readonly (ChangeRequestRead & { binding_id: string })[],
): JudgedCommit[] {
  const latest = new Map<string, ChangeRequest>();
  for (const item of items)
    for (const request of item.change_requests) {
      const current = latest.get(item.binding_id);
      if (
        current === undefined ||
        (request.submitted_at ?? NO_TIME) >= (current.submitted_at ?? NO_TIME)
      )
        latest.set(item.binding_id, request);
    }
  return [...latest].map(([binding_id, request]) => ({
    binding_id,
    commit: request.commit_id,
  }));
}

function testedCommits(testedInput: TestedInput | null): JudgedCommit[] {
  if (testedInput === null) return [];
  const addresses = Array.isArray(testedInput) ? testedInput : [testedInput];
  return addresses.flatMap((address) =>
    address.kind === AssetKind.Repository
      ? [{ binding_id: address.binding_id, commit: address.commit }]
      : [],
  );
}

interface RepositoryName {
  binding_id: string;
  name: string;
}

export interface JudgedCommit {
  binding_id: string;
  commit: string;
}

export interface Verdict {
  text: string;
  judged: JudgedCommit[];
}

export interface Prior {
  verdict: Verdict | null;
  cleared: string | null;
}

export async function readPrior(
  run: ExecutionRun,
  repositories: readonly RepositoryName[],
): Promise<Prior> {
  const rework = await readReworkAssessment(run);
  if (rework)
    return {
      verdict: {
        text: rework.rationale,
        judged: testedCommits(rework.tested_input),
      },
      cleared: null,
    };
  const requested = await readRequestedChanges(run, repositories);
  if (requested !== null) return { verdict: requested, cleared: null };
  const cleared = await readClearedAssessment(run);
  return {
    verdict: null,
    cleared:
      cleared === null || cleared.result === AssessmentResult.Success
        ? null
        : cleared.rationale,
  };
}
