import assert from "node:assert/strict";
import type { Logger } from "pino";
import {
  apiKeySecretSchema,
  GrantKind,
  InboundOperation,
  type InboundGrantInput,
  type Material,
} from "../custody/contract.ts";
import type { CallerIdentity, ServiceIdentity } from "../kernel/caller.ts";
import {
  abortSignal,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { CodedError } from "../kernel/errors.ts";
import { OperationResultType } from "../kernel/operation.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  GitHubTargetKind,
  githubCheckpointSchema,
  newerEvents,
  repositoryOf,
  type GitHubAnswer,
  type GitHubCheckpoint,
  type GitHubFailure,
  type GitHubEvent,
  type GitHubEventsAnswer,
  type GitHubPlatform,
} from "../repository/github.ts";
import type { IntakeCustody } from "./action-check.ts";
import { configurationSchemaOf, resourceIdentityOf } from "./configuration.ts";
import {
  InboundKind,
  InboundPlatform,
  PLATFORM_CALL_DEADLINE_MS,
  POLL_BACKOFF_MAX_MS,
  POLL_WAIT_MAX_MS,
  type UnresolvedRequestCounter,
} from "./contract.ts";
import { findEvent, insertEvent, pendingCount } from "./event-store.ts";
import {
  readInbound,
  writeCheckpoint,
  type InboundRow,
} from "./inbound-store.ts";

const RUNNING_AFTER_STOP = 0;
const EMPTY_TEXT_LENGTH = 0;
const PENDING_LIMIT_FLOOR = 0;
const EXHAUSTED_ROOM = 0;
const POLL_INTERVAL_FLOOR_MS = 0;
const IMMEDIATE_OFFSET_MS = 0;
const ROOM_PER_EVENT = 1;
const NO_REFUSALS = 0;
const REFUSAL_STEP = 1;
const REFUSAL_COUNT_LIMIT = 32;
const BACKOFF_FACTOR = 2;
const UNKNOWN_CODE = "system.operation.unknown";
const INDETERMINATE_CODE = "indeterminate";
const NO_UNRESOLVED_REQUESTS = 0;
const REQUEST_FAILURE_MESSAGE = "intake: a poll request of an inbound failed.";
const DEMAND_FAILURE_MESSAGE =
  "intake: the demand check of a poll inbound failed.";
const EMPTY_CHECKPOINT: GitHubCheckpoint = {
  etag: null,
  newest_event_id: null,
};

export interface PollCycleDependencies {
  store: Store;
  logger: Logger;
  identity: ServiceIdentity;
  custody: Pick<IntakeCustody, "authorizeOperation" | "release">;
  github: Pick<GitHubPlatform, "listEvents">;
  unresolvedRequests: UnresolvedRequestCounter;
  pendingEventLimit: number;
  wake(): void;
}

export interface PollDependencies extends PollCycleDependencies {
  context: Context;
  pollIntervalMs: number;
}

export const CycleOutcome = { Continue: "continue", Gone: "gone" } as const;
export type CycleOutcome = (typeof CycleOutcome)[keyof typeof CycleOutcome];

export const CycleAnswer = {
  Skipped: "skipped",
  Answered: "answered",
  SecondaryRefusal: "secondary_refusal",
} as const;
export type CycleAnswer = (typeof CycleAnswer)[keyof typeof CycleAnswer];

export interface CycleResult {
  outcome: CycleOutcome;
  answer: CycleAnswer;
  waitMs: number | null;
}

export interface PollWait {
  waitMs: number;
  secondaryRefusals: number;
}

interface Loop {
  timer: NodeJS.Timeout | null;
  context: CancellationContext;
  cycle: Promise<void> | null;
  secondaryRefusals: number;
}

export interface PollTarget {
  facts: InboundGrantInput;
  owner: string;
  repo: string;
  checkpoint: GitHubCheckpoint;
}

type Preparation =
  { ready: true; target: PollTarget } | { ready: false; outcome: CycleOutcome };

export interface Hold {
  material: Material | null;
}

export function checkpointOf(text: string | null): GitHubCheckpoint {
  if (text === null) return EMPTY_CHECKPOINT;
  return githubCheckpointSchema.parse(JSON.parse(text));
}

export function pollTargetOf(row: InboundRow): PollTarget {
  assert.equal(
    row.kind,
    InboundKind.Poll,
    "A poll target reads a poll inbound.",
  );
  assert.equal(row.platform, InboundPlatform.GitHub);
  assert.ok(row.credential !== null, "A poll names a credential.");
  const { resource } = configurationSchemaOf(row.kind, row.platform).parse(
    JSON.parse(row.configuration),
  );
  const { owner, repo } = repositoryOf({
    kind: GitHubTargetKind.Inbound,
    resource,
  });
  return {
    facts: {
      inboundId: row.id,
      projectId: row.project_id,
      credential: row.credential,
      platform: row.platform,
      resource,
    },
    owner,
    repo,
    checkpoint: checkpointOf(row.checkpoint),
  };
}

export interface PollReleaseDependencies {
  identity: ServiceIdentity;
  custody: Pick<IntakeCustody, "authorizeOperation" | "release">;
}

export interface PollEventsRequest {
  requester: CallerIdentity;
  context: Context;
  material: Material;
  owner: string;
  repo: string;
  etag: string | null;
}

export function releasePollGrant(
  dependencies: PollReleaseDependencies,
  tx: Transaction,
  facts: InboundGrantInput,
): Material {
  assert.ok(
    facts.inboundId.length > EMPTY_TEXT_LENGTH,
    "A poll names its inbound.",
  );
  assert.ok(
    facts.credential.length > EMPTY_TEXT_LENGTH,
    "A poll names a credential.",
  );
  const now = Date.now();
  const grant = dependencies.custody.authorizeOperation(
    tx,
    {
      kind: GrantKind.Inbound,
      identity: dependencies.identity,
      inbound: facts,
      operation: InboundOperation.Poll,
    },
    now,
  );
  assert.equal(grant.execution, null, "A poll release pins nothing.");
  return dependencies.custody.release(tx, grant, now);
}

export async function requestPollEvents(
  github: Pick<GitHubPlatform, "listEvents">,
  request: PollEventsRequest,
): Promise<GitHubAnswer<GitHubEventsAnswer>> {
  assert.ok(request.owner.length > EMPTY_TEXT_LENGTH, "A poll names an owner.");
  assert.ok(
    request.repo.length > EMPTY_TEXT_LENGTH,
    "A poll names a repository.",
  );
  const token = apiKeySecretSchema.parse(request.material.value()).key;
  assert.ok(
    token.length > EMPTY_TEXT_LENGTH,
    "A poll request carries a token.",
  );
  const { signal, dispose } = abortSignal(request.context);
  try {
    return await github.listEvents(
      {
        token,
        requester: request.requester,
        signal,
        deadlineAt: Date.now() + PLATFORM_CALL_DEADLINE_MS,
      },
      { owner: request.owner, repo: request.repo, etag: request.etag },
    );
  } finally {
    dispose();
  }
}

const SKIPPED_CYCLE: CycleResult = {
  outcome: CycleOutcome.Continue,
  answer: CycleAnswer.Skipped,
  waitMs: null,
};
const GONE_CYCLE: CycleResult = {
  outcome: CycleOutcome.Gone,
  answer: CycleAnswer.Skipped,
  waitMs: null,
};

function answeredCycle(waitMs: number | null): CycleResult {
  return {
    outcome: CycleOutcome.Continue,
    answer: CycleAnswer.Answered,
    waitMs,
  };
}

function failedCycle(answer: GitHubFailure): CycleResult {
  if (answer.rate_limit === undefined) return answeredCycle(null);
  if (answer.rate_limit.wait_ms === null)
    return {
      outcome: CycleOutcome.Continue,
      answer: CycleAnswer.SecondaryRefusal,
      waitMs: null,
    };
  return answeredCycle(answer.rate_limit.wait_ms);
}

export function nextWait(
  intervalMs: number,
  secondaryRefusals: number,
  result: CycleResult,
): PollWait {
  assert.ok(Number.isSafeInteger(intervalMs) && intervalMs > NO_REFUSALS);
  assert.ok(Number.isSafeInteger(secondaryRefusals));
  assert.ok(secondaryRefusals >= NO_REFUSALS);
  if (result.answer === CycleAnswer.Skipped)
    return { waitMs: intervalMs, secondaryRefusals };
  if (result.answer === CycleAnswer.Answered)
    return {
      waitMs: Math.min(
        Math.max(intervalMs, result.waitMs ?? NO_REFUSALS),
        POLL_WAIT_MAX_MS,
      ),
      secondaryRefusals: NO_REFUSALS,
    };
  const refusals = Math.min(
    secondaryRefusals + REFUSAL_STEP,
    REFUSAL_COUNT_LIMIT,
  );
  return {
    waitMs: Math.min(
      Math.max(
        intervalMs,
        Math.min(intervalMs * BACKOFF_FACTOR ** refusals, POLL_BACKOFF_MAX_MS),
      ),
      POLL_WAIT_MAX_MS,
    ),
    secondaryRefusals: refusals,
  };
}

function inspectCycle(
  dependencies: PollCycleDependencies,
  tx: Transaction,
  inboundId: string,
): Preparation {
  const row = readInbound(tx, inboundId);
  if (row === null) return { ready: false, outcome: CycleOutcome.Gone };
  assert.equal(row.kind, InboundKind.Poll, "A poll loop reads a poll inbound.");
  if (pendingCount(tx) >= dependencies.pendingEventLimit)
    return { ready: false, outcome: CycleOutcome.Continue };
  const target = pollTargetOf(row);
  assert.equal(target.facts.inboundId, inboundId);
  return { ready: true, target };
}

function releaseCycle(
  dependencies: PollCycleDependencies,
  tx: Transaction,
  target: PollTarget,
  hold: Hold,
): boolean {
  assert.equal(hold.material, null, "A cycle releases once.");
  if (readInbound(tx, target.facts.inboundId) === null) return false;
  hold.material = releasePollGrant(dependencies, tx, target.facts);
  return true;
}

async function hasDemand(
  dependencies: PollCycleDependencies,
  target: PollTarget,
  context: Context,
): Promise<boolean> {
  const result = await dependencies.unresolvedRequests(
    {
      project_id: target.facts.projectId,
      resource_identity: resourceIdentityOf(InboundPlatform.GitHub, {
        resource: target.facts.resource,
      }),
    },
    { identity: dependencies.identity, context },
  );
  if (result.type === OperationResultType.Completed)
    return result.data.count > NO_UNRESOLVED_REQUESTS;
  logFailure(
    dependencies.logger,
    target.facts.inboundId,
    result.type === OperationResultType.Failure
      ? result.error.error.code
      : INDETERMINATE_CODE,
    DEMAND_FAILURE_MESSAGE,
  );
  return false;
}

export function storeBatch(
  tx: Transaction,
  pendingEventLimit: number,
  inboundId: string,
  answer: { etag: string | null; events: GitHubEvent[] },
): boolean {
  assert.ok(Number.isSafeInteger(pendingEventLimit));
  assert.ok(
    inboundId.length > EMPTY_TEXT_LENGTH,
    "An inbound identity is required.",
  );
  const row = readInbound(tx, inboundId);
  if (row === null) return false;
  const previous = checkpointOf(row.checkpoint);
  let room = pendingEventLimit - pendingCount(tx);
  let newest = previous.newest_event_id;
  let unstored = false;
  for (const event of newerEvents(answer.events, previous.newest_event_id)) {
    if (findEvent(tx, inboundId, event.id) !== null) continue;
    if (room <= EXHAUSTED_ROOM) {
      unstored = true;
      break;
    }
    insertEvent(tx, {
      inbound_id: inboundId,
      event_id: event.id,
      event: event.body,
      metadata: { event: event.type },
      created_at: Date.now(),
    });
    newest = event.id;
    room -= ROOM_PER_EVENT;
  }
  writeCheckpoint(
    tx,
    inboundId,
    canonicalJSON(
      githubCheckpointSchema.parse({
        etag: unstored ? null : answer.etag,
        newest_event_id: newest,
      }),
    ),
  );
  return true;
}

function logFailure(
  logger: Logger,
  inboundId: string,
  code: string,
  message = REQUEST_FAILURE_MESSAGE,
): void {
  assert.ok(
    inboundId.length > EMPTY_TEXT_LENGTH,
    "An inbound identity is required.",
  );
  assert.ok(code.length > EMPTY_TEXT_LENGTH, "A failure names a code.");
  logger.warn({ inbound_id: inboundId, code }, message);
}

export async function pollCycle(
  dependencies: PollCycleDependencies,
  inboundId: string,
  context: Context,
): Promise<CycleResult> {
  const hold: Hold = { material: null };
  try {
    const preparation = dependencies.store.transaction((tx) =>
      inspectCycle(dependencies, tx, inboundId),
    );
    if (!preparation.ready)
      return preparation.outcome === CycleOutcome.Gone
        ? GONE_CYCLE
        : SKIPPED_CYCLE;
    const { target } = preparation;
    if (!(await hasDemand(dependencies, target, context))) return SKIPPED_CYCLE;
    const present = dependencies.store.transaction((tx) =>
      releaseCycle(dependencies, tx, target, hold),
    );
    if (!present) return GONE_CYCLE;
    assert.ok(hold.material, "A committed release holds the material.");
    const answer = await requestPollEvents(dependencies.github, {
      requester: dependencies.identity,
      context,
      material: hold.material,
      owner: target.owner,
      repo: target.repo,
      etag: target.checkpoint.etag,
    });
    if (context.err()) return SKIPPED_CYCLE;
    if (!answer.ok) {
      logFailure(dependencies.logger, inboundId, answer.code);
      return failedCycle(answer);
    }
    const waitMs = answer.value.poll_interval_ms ?? null;
    if (answer.value.notModified) return answeredCycle(waitMs);
    const batch = answer.value;
    const stored = dependencies.store.transaction((tx) =>
      storeBatch(tx, dependencies.pendingEventLimit, inboundId, batch),
    );
    if (!stored) return GONE_CYCLE;
    dependencies.wake();
    return answeredCycle(waitMs);
  } finally {
    hold.material?.drop();
  }
}

export class PollLoops {
  readonly #dependencies: PollDependencies;
  readonly #loops = new Map<string, Loop>();
  readonly #cycles = new Set<Promise<void>>();
  #quiescent = false;

  constructor(dependencies: PollDependencies) {
    assert.ok(Number.isSafeInteger(dependencies.pollIntervalMs));
    assert.ok(dependencies.pollIntervalMs > POLL_INTERVAL_FLOOR_MS);
    assert.ok(Number.isSafeInteger(dependencies.pendingEventLimit));
    assert.ok(dependencies.pendingEventLimit > PENDING_LIMIT_FLOOR);
    this.#dependencies = dependencies;
  }

  start(inboundId: string): void {
    this.#open(inboundId, IMMEDIATE_OFFSET_MS);
  }

  startAll(inboundIds: readonly string[]): void {
    const intervalMs = this.#dependencies.pollIntervalMs;
    inboundIds.forEach((inboundId, index) => {
      this.#open(
        inboundId,
        Math.floor((index * intervalMs) / inboundIds.length),
      );
    });
  }

  stop(inboundId: string): void {
    assert.ok(
      inboundId.length > EMPTY_TEXT_LENGTH,
      "An inbound identity is required.",
    );
    const loop = this.#loops.get(inboundId);
    if (loop === undefined) return;
    this.#loops.delete(inboundId);
    if (loop.timer !== null) clearTimeout(loop.timer);
    loop.timer = null;
    loop.context.cancel();
  }

  quiesce(): void {
    this.#quiescent = true;
    for (const inboundId of [...this.#loops.keys()]) this.stop(inboundId);
    assert.equal(this.#loops.size, RUNNING_AFTER_STOP, "Every loop stops.");
  }

  async drain(): Promise<void> {
    assert.ok(this.#quiescent, "A drain follows the quiescence.");
    await Promise.all([...this.#cycles]);
    assert.equal(this.#cycles.size, RUNNING_AFTER_STOP, "Every cycle ends.");
  }

  async stopAll(): Promise<void> {
    this.quiesce();
    await this.drain();
  }

  #open(inboundId: string, startOffsetMs: number): void {
    assert.ok(
      inboundId.length > EMPTY_TEXT_LENGTH,
      "An inbound identity is required.",
    );
    assert.ok(Number.isSafeInteger(startOffsetMs));
    assert.ok(startOffsetMs >= IMMEDIATE_OFFSET_MS);
    assert.ok(startOffsetMs < this.#dependencies.pollIntervalMs);
    if (this.#quiescent || this.#loops.has(inboundId)) return;
    const loop: Loop = {
      timer: null,
      context: new CancellationContext(this.#dependencies.context),
      cycle: null,
      secondaryRefusals: NO_REFUSALS,
    };
    this.#loops.set(inboundId, loop);
    this.#arm(
      inboundId,
      loop,
      this.#dependencies.pollIntervalMs + startOffsetMs,
    );
  }

  #arm(inboundId: string, loop: Loop, delayMs: number): void {
    if (this.#loops.get(inboundId) !== loop) return;
    assert.equal(loop.timer, null, "A loop holds one timer.");
    assert.equal(loop.cycle, null, "A loop arms after its cycle ends.");
    assert.ok(Number.isSafeInteger(delayMs) && delayMs > IMMEDIATE_OFFSET_MS);
    loop.timer = setTimeout(() => this.#tick(inboundId, loop), delayMs);
  }

  #tick(inboundId: string, loop: Loop): void {
    assert.notEqual(loop.timer, null, "A tick follows an armed timer.");
    loop.timer = null;
    const cycle = this.#cycle(inboundId, loop.context).then((result) => {
      this.#cycles.delete(cycle);
      loop.cycle = null;
      if (result.outcome === CycleOutcome.Gone) {
        this.#forget(inboundId, loop);
        return;
      }
      const wait = nextWait(
        this.#dependencies.pollIntervalMs,
        loop.secondaryRefusals,
        result,
      );
      loop.secondaryRefusals = wait.secondaryRefusals;
      this.#arm(inboundId, loop, wait.waitMs);
    });
    this.#cycles.add(cycle);
    loop.cycle = cycle;
  }

  #forget(inboundId: string, loop: Loop): void {
    if (this.#loops.get(inboundId) !== loop) return;
    this.stop(inboundId);
    assert.ok(!this.#loops.has(inboundId), "A gone inbound holds no loop.");
  }

  async #cycle(inboundId: string, context: Context): Promise<CycleResult> {
    try {
      return await pollCycle(this.#dependencies, inboundId, context);
    } catch (error) {
      logFailure(
        this.#dependencies.logger,
        inboundId,
        error instanceof CodedError ? error.code : UNKNOWN_CODE,
      );
      return SKIPPED_CYCLE;
    }
  }
}
