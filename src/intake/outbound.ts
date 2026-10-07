import assert from "node:assert/strict";
import type { Logger } from "pino";
import type { Material } from "../custody/contract.ts";
import {
  abortSignal,
  CancellationContext,
  type Context,
  DeadlineExceeded,
} from "../kernel/context.ts";
import { diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  IntakeErrorCode,
  OutboundRequestState,
  RESULT_MAX_BYTES,
  ResultClass,
  resultClassSchema,
  type OutboundOperationValue,
  type OutboundRequestStateValue,
  type ResultClassValue,
} from "./contract.ts";
import {
  fail,
  findById,
  findByKey,
  insertPending,
  OutboundKeyConflict,
  outboundRecord,
  succeed,
  type OutboundFailure,
  type OutboundRow,
} from "./outbound-store.ts";

const NO_LENGTH = 0;
const NO_DURATION = 0;
const TIMEOUT_CODE = "timeout";
const CODE_SEPARATOR = ": ";
const PENDING_UNMATCHED_MESSAGE =
  "The read-back found no effect of the pending request.";
const PENDING_SOURCES: readonly OutboundRequestStateValue[] = [
  OutboundRequestState.Pending,
];
const MATCH_SOURCES: readonly OutboundRequestStateValue[] = [
  OutboundRequestState.Pending,
  OutboundRequestState.Failed,
];

export const FinalizationKind = { Answer: "answer", Error: "error" } as const;
const AdmissionKind = {
  Fresh: "fresh",
  Stored: "stored",
  Repeat: "repeat",
} as const;
const OutcomeKind = {
  None: "none",
  Success: "success",
  Failure: "failure",
  Match: "match",
} as const;
const RaceKind = {
  Settled: "settled",
  Rejected: "rejected",
  Deadline: "deadline",
} as const;

export type CallAnswer =
  | { ok: true; result: unknown }
  | { ok: false; class: ResultClassValue; code: string; message: string };
export type OutboundAnswer = CallAnswer;
export type ReadBack = { match: true; result: unknown } | { match: false };
export type Finalization<TBody> =
  | { kind: typeof FinalizationKind.Answer; body: TBody }
  | { kind: typeof FinalizationKind.Error; error: Error };

export interface OutboundScope {
  context: Context;
  signal: AbortSignal;
}

export interface OutboundAuthorization {
  operation: OutboundOperationValue;
  project_id: string;
  credential: string | null;
  material: Material | null;
}

export interface ResultCodec {
  encode(value: unknown): unknown;
  decode(stored: unknown): unknown;
}

export interface OutboundRun<TBody> {
  requestKey: string;
  deadlineMs: number;
  resultCodec: ResultCodec;
  authorize(tx: Transaction, now: number): OutboundAuthorization;
  call(material: Material | null, scope: OutboundScope): Promise<CallAnswer>;
  readBack(material: Material | null, scope: OutboundScope): Promise<ReadBack>;
  finalize(answer: OutboundAnswer): Finalization<TBody>;
}

export interface OutboundDependencies {
  store: Store;
  logger: Logger;
  inFlight: Set<string>;
}

interface Hold {
  material: Material | null;
  owned: string | null;
}

type Admission =
  | { kind: typeof AdmissionKind.Fresh; id: string }
  | { kind: typeof AdmissionKind.Stored; result: unknown }
  | { kind: typeof AdmissionKind.Repeat; row: OutboundRow };

type Outcome =
  | { kind: typeof OutcomeKind.None }
  | { kind: typeof OutcomeKind.Success; id: string; result: unknown }
  | { kind: typeof OutcomeKind.Failure; id: string; item: OutboundFailure }
  | { kind: typeof OutcomeKind.Match; id: string; result: unknown };

interface Settlement {
  outcome: Outcome;
  answer: OutboundAnswer;
}

type Race<T> =
  | { kind: typeof RaceKind.Settled; value: T }
  | { kind: typeof RaceKind.Rejected; error: unknown }
  | { kind: typeof RaceKind.Deadline; reason: Error };

const NO_OUTCOME: Outcome = Object.freeze({ kind: OutcomeKind.None });

export async function runOutbound<TBody>(
  dependencies: OutboundDependencies,
  caller: CallerContext,
  request: OutboundRun<TBody>,
): Promise<TBody> {
  assert.ok(
    request.requestKey.length > NO_LENGTH,
    "A request key is required.",
  );
  assert.ok(
    Number.isSafeInteger(request.deadlineMs) &&
      request.deadlineMs > NO_DURATION,
    "A deadline must be a positive integer of milliseconds.",
  );
  const hold: Hold = { material: null, owned: null };
  try {
    const admission = dependencies.store.transaction((tx) =>
      admit(dependencies.inFlight, request, tx, hold),
    );
    const settlement = await settle(
      dependencies.logger,
      caller.context,
      request,
      hold.material,
      admission,
    );
    return finish(dependencies.store, caller, request, settlement);
  } finally {
    if (hold.owned !== null) dependencies.inFlight.delete(hold.owned);
    hold.material?.drop();
  }
}

function admit<TBody>(
  inFlight: Set<string>,
  request: OutboundRun<TBody>,
  tx: Transaction,
  hold: Hold,
): Admission {
  const now = Date.now();
  const authorization = request.authorize(tx, now);
  hold.material = authorization.material;
  assert.ok(authorization.project_id.length > NO_LENGTH);
  const existing = findByKey(tx, authorization.operation, request.requestKey);
  if (existing !== null)
    return repeat(inFlight, existing, request.resultCodec, hold);
  const id = insertOrConflict(tx, authorization, request.requestKey, now);
  if (id !== null) {
    inFlight.add(id);
    hold.owned = id;
    return { kind: AdmissionKind.Fresh, id };
  }
  const conflicting = findByKey(
    tx,
    authorization.operation,
    request.requestKey,
  );
  assert.ok(conflicting !== null, "A key conflict names an existing request.");
  return repeat(inFlight, conflicting, request.resultCodec, hold);
}

function insertOrConflict(
  tx: Transaction,
  authorization: OutboundAuthorization,
  requestKey: string,
  now: number,
): string | null {
  assert.ok(requestKey.length > NO_LENGTH);
  assert.ok(Number.isSafeInteger(now));
  try {
    return insertPending(tx, {
      project_id: authorization.project_id,
      operation: authorization.operation,
      request_key: requestKey,
      credential: authorization.credential,
      created_at: now,
    });
  } catch (error) {
    if (error instanceof OutboundKeyConflict) return null;
    throw error;
  }
}

function repeat(
  inFlight: Set<string>,
  row: OutboundRow,
  codec: ResultCodec,
  hold: Hold,
): Admission {
  assert.equal(hold.owned, null, "A repeat starts with no owned identity.");
  if (inFlight.has(row.id))
    throw new OperationError(
      HttpStatus.Conflict,
      IntakeErrorCode.OutboundRequestInFlight,
      "The call of this outbound request runs.",
    );
  if (row.state === OutboundRequestState.Discarded)
    throw new OperationError(
      HttpStatus.Conflict,
      IntakeErrorCode.OutboundRequestDiscarded,
      "A human discarded this outbound request.",
    );
  if (row.state === OutboundRequestState.Succeeded) {
    assert.ok(row.result !== null, "A succeeded request holds a result.");
    return {
      kind: AdmissionKind.Stored,
      result: codec.decode(JSON.parse(row.result)),
    };
  }
  inFlight.add(row.id);
  hold.owned = row.id;
  return { kind: AdmissionKind.Repeat, row };
}

async function settle<TBody>(
  logger: Logger,
  context: Context,
  request: OutboundRun<TBody>,
  material: Material | null,
  admission: Admission,
): Promise<Settlement> {
  if (admission.kind === AdmissionKind.Stored)
    return {
      outcome: NO_OUTCOME,
      answer: { ok: true, result: admission.result },
    };
  if (admission.kind === AdmissionKind.Fresh)
    return callOnce(context, request, material, admission.id);
  return readBackOnce(logger, context, request, material, admission.row);
}

async function callOnce<TBody>(
  context: Context,
  request: OutboundRun<TBody>,
  material: Material | null,
  id: string,
): Promise<Settlement> {
  const race = await withDeadline(context, request.deadlineMs, (scope) =>
    request.call(material, scope),
  );
  if (race.kind === RaceKind.Rejected) throw race.error;
  if (race.kind === RaceKind.Deadline) return ended(id, race.reason);
  const answer = race.value;
  if (answer.ok)
    return {
      outcome: { kind: OutcomeKind.Success, id, result: answer.result },
      answer,
    };
  return refused(id, answer);
}

function ended(id: string, reason: Error): Settlement {
  const message = reason.message;
  if (!(reason instanceof DeadlineExceeded))
    return refused(id, {
      ok: false,
      class: ResultClass.UnknownOutcome,
      code: ResultClass.UnknownOutcome,
      message,
    });
  return {
    outcome: {
      kind: OutcomeKind.Failure,
      id,
      item: { code: TIMEOUT_CODE, message },
    },
    answer: {
      ok: false,
      class: ResultClass.UnknownOutcome,
      code: TIMEOUT_CODE,
      message,
    },
  };
}

function refused(
  id: string,
  answer: Extract<OutboundAnswer, { ok: false }>,
): Settlement {
  assert.ok(resultClassSchema.safeParse(answer.class).success);
  assert.ok(answer.code.length > NO_LENGTH, "A refusal names its code.");
  const item = {
    code: answer.class,
    message: answer.code + CODE_SEPARATOR + answer.message,
  };
  return { outcome: { kind: OutcomeKind.Failure, id, item }, answer };
}

async function readBackOnce<TBody>(
  logger: Logger,
  context: Context,
  request: OutboundRun<TBody>,
  material: Material | null,
  row: OutboundRow,
): Promise<Settlement> {
  assert.ok(MATCH_SOURCES.includes(row.state), "A read-back needs a repeat.");
  const race = await withDeadline(context, request.deadlineMs, (scope) =>
    request.readBack(material, scope),
  );
  if (race.kind === RaceKind.Settled && race.value.match) {
    const result = race.value.result;
    return {
      outcome: { kind: OutcomeKind.Match, id: row.id, result },
      answer: { ok: true, result },
    };
  }
  if (race.kind !== RaceKind.Settled)
    logger.warn(
      {
        outbound_request_id: row.id,
        operation: row.operation,
        outcome: race.kind,
        reason:
          race.kind === RaceKind.Rejected
            ? diagnostic(race.error)
            : race.reason.message,
      },
      "intake: the read-back of an outbound request did not answer.",
    );
  return { outcome: NO_OUTCOME, answer: unmatched(row) };
}

function unmatched(row: OutboundRow): OutboundAnswer {
  if (row.state === OutboundRequestState.Pending)
    return {
      ok: false,
      class: ResultClass.UnknownOutcome,
      code: ResultClass.UnknownOutcome,
      message: PENDING_UNMATCHED_MESSAGE,
    };
  const items = outboundRecord(row).error;
  assert.ok(items !== null && items.length > NO_LENGTH);
  const newest = items[items.length - 1];
  assert.ok(newest !== undefined, "A failed request holds an error item.");
  const stored = resultClassSchema.safeParse(newest.code);
  if (!stored.success)
    return {
      ok: false,
      class: ResultClass.UnknownOutcome,
      code: newest.code,
      message: newest.message,
    };
  const separator = newest.message.indexOf(CODE_SEPARATOR);
  assert.ok(separator > NO_LENGTH, "A stored refusal names its code.");
  return {
    ok: false,
    class: stored.data,
    code: newest.message.slice(0, separator),
    message: newest.message.slice(separator + CODE_SEPARATOR.length),
  };
}

async function withDeadline<T>(
  parent: Context,
  deadlineMs: number,
  work: (scope: OutboundScope) => Promise<T>,
): Promise<Race<T>> {
  assert.ok(deadlineMs > NO_DURATION);
  const context = new CancellationContext(parent, Date.now() + deadlineMs);
  const { signal, dispose } = abortSignal(context);
  try {
    const ended = context.done().then((): Race<T> => {
      const reason = context.err();
      assert.ok(reason !== null, "An ended scope holds its reason.");
      return { kind: RaceKind.Deadline, reason };
    });
    const settled = Promise.resolve()
      .then(() => work({ context, signal }))
      .then(
        (value): Race<T> => ({ kind: RaceKind.Settled, value }),
        (error: unknown): Race<T> => ({ kind: RaceKind.Rejected, error }),
      );
    return await Promise.race([settled, ended]);
  } finally {
    dispose();
    context.cancel();
  }
}

function finish<TBody>(
  store: Store,
  caller: CallerContext,
  request: OutboundRun<TBody>,
  settlement: Settlement,
): TBody {
  const codec = request.resultCodec;
  const final = request.finalize(settlement.answer);
  if (final.kind === FinalizationKind.Answer)
    return caller.commit((tx) => {
      writeState(tx, codec, settlement.outcome);
      return final.body;
    });
  assert.ok(final.error instanceof Error, "A finalization error is an Error.");
  store.transaction((tx) => writeState(tx, codec, settlement.outcome));
  throw final.error;
}

function writeState(tx: Transaction, codec: ResultCodec, outcome: Outcome) {
  if (outcome.kind === OutcomeKind.None) return;
  if (outcome.kind === OutcomeKind.Failure) {
    if (!fail(tx, outcome.id, outcome.item, Date.now()))
      confirmUnchanged(tx, outcome.id, PENDING_SOURCES);
    return;
  }
  const sources =
    outcome.kind === OutcomeKind.Success ? PENDING_SOURCES : MATCH_SOURCES;
  const stored = encodeResult(codec, outcome.result);
  if (!succeed(tx, outcome.id, stored, sources))
    confirmUnchanged(tx, outcome.id, sources);
}

function encodeResult(codec: ResultCodec, result: unknown): unknown {
  const stored = codec.encode(result);
  const text = canonicalJSON(stored);
  assert.ok(text.length > NO_LENGTH, "A result encodes to JSON text.");
  assert.ok(
    Buffer.byteLength(text, "utf8") <= RESULT_MAX_BYTES,
    "A result must fit its byte bound.",
  );
  return stored;
}

function confirmUnchanged(
  tx: Transaction,
  id: string,
  sources: readonly OutboundRequestStateValue[],
): void {
  assert.ok(sources.length > NO_LENGTH);
  const row = findById(tx, id);
  assert.ok(
    row === null || !sources.includes(row.state),
    "A conditional write that changes no row meets another state.",
  );
}
