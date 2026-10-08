import assert from "node:assert/strict";
import type { Logger } from "pino";
import {
  apiKeySecretSchema,
  GrantKind,
  InboundOperation,
  type Material,
} from "../custody/contract.ts";
import type { ServiceIdentity } from "../kernel/caller.ts";
import {
  abortSignal,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { CodedError } from "../kernel/errors.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  GitHubTargetKind,
  githubCheckpointSchema,
  newerEvents,
  repositoryOf,
  type GitHubAnswer,
  type GitHubCheckpoint,
  type GitHubEvent,
  type GitHubEventsAnswer,
  type GitHubPlatform,
} from "../repository/github.ts";
import type { IntakeCustody } from "./action-check.ts";
import { configurationSchemaOf } from "./configuration.ts";
import {
  InboundKind,
  InboundPlatform,
  PLATFORM_CALL_DEADLINE_MS,
} from "./contract.ts";
import { findEvent, insertEvent, pendingCount } from "./event-store.ts";
import {
  readInbound,
  writeCheckpoint,
  type InboundRow,
} from "./inbound-store.ts";

const NO_LENGTH = 0;
const NO_ROOM = 0;
const NO_INTERVAL_MS = 0;
const ONE_ROW = 1;
const UNKNOWN_CODE = "system.operation.unknown";
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
  pendingEventLimit: number;
  wake(): void;
}

export interface PollDependencies extends PollCycleDependencies {
  context: Context;
  pollIntervalMs: number;
}

export const CycleOutcome = { Continue: "continue", Gone: "gone" } as const;
export type CycleOutcome = (typeof CycleOutcome)[keyof typeof CycleOutcome];

interface Loop {
  timer: NodeJS.Timeout | null;
  context: CancellationContext;
  cycle: Promise<void> | null;
}

interface PollTarget {
  inboundId: string;
  owner: string;
  repo: string;
  checkpoint: GitHubCheckpoint;
}

type Preparation =
  { ready: true; target: PollTarget } | { ready: false; outcome: CycleOutcome };

interface Hold {
  material: Material | null;
}

function checkpointOf(text: string | null): GitHubCheckpoint {
  if (text === null) return EMPTY_CHECKPOINT;
  return githubCheckpointSchema.parse(JSON.parse(text));
}

function releasePoll(
  dependencies: PollCycleDependencies,
  tx: Transaction,
  row: InboundRow,
  resource: string,
): Material {
  assert.ok(row.credential !== null, "A poll names a credential.");
  const now = Date.now();
  const grant = dependencies.custody.authorizeOperation(
    tx,
    {
      kind: GrantKind.Inbound,
      identity: dependencies.identity,
      inbound: {
        inboundId: row.id,
        projectId: row.project_id,
        credential: row.credential,
        platform: row.platform,
        resource,
      },
      operation: InboundOperation.Poll,
    },
    now,
  );
  assert.equal(grant.execution, null, "A poll release pins nothing.");
  return dependencies.custody.release(tx, grant, now);
}

function prepareCycle(
  dependencies: PollCycleDependencies,
  tx: Transaction,
  inboundId: string,
  hold: Hold,
): Preparation {
  assert.equal(hold.material, null, "A cycle releases once.");
  const row = readInbound(tx, inboundId);
  if (row === null) return { ready: false, outcome: CycleOutcome.Gone };
  assert.equal(row.kind, InboundKind.Poll, "A poll loop reads a poll inbound.");
  assert.equal(row.platform, InboundPlatform.GitHub);
  if (pendingCount(tx) >= dependencies.pendingEventLimit)
    return { ready: false, outcome: CycleOutcome.Continue };
  const checkpoint = checkpointOf(row.checkpoint);
  const { resource } = configurationSchemaOf(row.kind, row.platform).parse(
    JSON.parse(row.configuration),
  );
  const { owner, repo } = repositoryOf({
    kind: GitHubTargetKind.Inbound,
    resource,
  });
  hold.material = releasePoll(dependencies, tx, row, resource);
  return { ready: true, target: { inboundId, owner, repo, checkpoint } };
}

async function requestEvents(
  dependencies: PollCycleDependencies,
  context: Context,
  material: Material,
  target: PollTarget,
): Promise<GitHubAnswer<GitHubEventsAnswer>> {
  const token = apiKeySecretSchema.parse(material.value()).key;
  assert.ok(token.length > NO_LENGTH, "A poll request carries a token.");
  const { signal, dispose } = abortSignal(context);
  try {
    return await dependencies.github.listEvents(
      {
        token,
        requester: dependencies.identity,
        signal,
        deadlineAt: Date.now() + PLATFORM_CALL_DEADLINE_MS,
      },
      { owner: target.owner, repo: target.repo, etag: target.checkpoint.etag },
    );
  } finally {
    dispose();
  }
}

export function storeBatch(
  tx: Transaction,
  pendingEventLimit: number,
  inboundId: string,
  answer: { etag: string | null; events: GitHubEvent[] },
): boolean {
  assert.ok(Number.isSafeInteger(pendingEventLimit));
  assert.ok(inboundId.length > NO_LENGTH, "An inbound identity is required.");
  const row = readInbound(tx, inboundId);
  if (row === null) return false;
  const previous = checkpointOf(row.checkpoint);
  let room = pendingEventLimit - pendingCount(tx);
  let newest = previous.newest_event_id;
  let unstored = false;
  for (const event of newerEvents(answer.events, previous.newest_event_id)) {
    if (findEvent(tx, inboundId, event.id) !== null) continue;
    if (room <= NO_ROOM) {
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
    room -= ONE_ROW;
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

function logFailure(logger: Logger, inboundId: string, code: string): void {
  assert.ok(inboundId.length > NO_LENGTH, "An inbound identity is required.");
  assert.ok(code.length > NO_LENGTH, "A failure names a code.");
  logger.warn(
    { inbound_id: inboundId, code },
    "intake: a poll request of an inbound failed.",
  );
}

export async function pollCycle(
  dependencies: PollCycleDependencies,
  inboundId: string,
  context: Context,
): Promise<CycleOutcome> {
  const hold: Hold = { material: null };
  try {
    const preparation = dependencies.store.transaction((tx) =>
      prepareCycle(dependencies, tx, inboundId, hold),
    );
    if (!preparation.ready) return preparation.outcome;
    assert.ok(hold.material, "A committed release holds the material.");
    const answer = await requestEvents(
      dependencies,
      context,
      hold.material,
      preparation.target,
    );
    if (context.err()) return CycleOutcome.Continue;
    if (!answer.ok) {
      logFailure(dependencies.logger, inboundId, answer.code);
      return CycleOutcome.Continue;
    }
    if (answer.value.notModified) return CycleOutcome.Continue;
    const batch = answer.value;
    const stored = dependencies.store.transaction((tx) =>
      storeBatch(tx, dependencies.pendingEventLimit, inboundId, batch),
    );
    if (!stored) return CycleOutcome.Gone;
    dependencies.wake();
    return CycleOutcome.Continue;
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
    assert.ok(dependencies.pollIntervalMs > NO_INTERVAL_MS);
    assert.ok(Number.isSafeInteger(dependencies.pendingEventLimit));
    assert.ok(dependencies.pendingEventLimit > NO_ROOM);
    this.#dependencies = dependencies;
  }

  start(inboundId: string): void {
    assert.ok(inboundId.length > NO_LENGTH, "An inbound identity is required.");
    if (this.#quiescent || this.#loops.has(inboundId)) return;
    const loop: Loop = {
      timer: null,
      context: new CancellationContext(this.#dependencies.context),
      cycle: null,
    };
    this.#loops.set(inboundId, loop);
    this.#arm(inboundId, loop);
  }

  stop(inboundId: string): void {
    assert.ok(inboundId.length > NO_LENGTH, "An inbound identity is required.");
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
    assert.equal(this.#loops.size, NO_LENGTH, "Every loop stops.");
  }

  async drain(): Promise<void> {
    assert.ok(this.#quiescent, "A drain follows the quiescence.");
    await Promise.all([...this.#cycles]);
    assert.equal(this.#cycles.size, NO_LENGTH, "Every cycle ends.");
  }

  async stopAll(): Promise<void> {
    this.quiesce();
    await this.drain();
  }

  #arm(inboundId: string, loop: Loop): void {
    if (this.#loops.get(inboundId) !== loop) return;
    assert.equal(loop.timer, null, "A loop holds one timer.");
    assert.equal(loop.cycle, null, "A loop arms after its cycle ends.");
    loop.timer = setTimeout(
      () => this.#tick(inboundId, loop),
      this.#dependencies.pollIntervalMs,
    );
  }

  #tick(inboundId: string, loop: Loop): void {
    assert.notEqual(loop.timer, null, "A tick follows an armed timer.");
    loop.timer = null;
    const cycle = this.#cycle(inboundId, loop.context).then((outcome) => {
      this.#cycles.delete(cycle);
      loop.cycle = null;
      if (outcome === CycleOutcome.Gone) this.#forget(inboundId, loop);
      else this.#arm(inboundId, loop);
    });
    this.#cycles.add(cycle);
    loop.cycle = cycle;
  }

  #forget(inboundId: string, loop: Loop): void {
    if (this.#loops.get(inboundId) !== loop) return;
    this.stop(inboundId);
    assert.ok(!this.#loops.has(inboundId), "A gone inbound holds no loop.");
  }

  async #cycle(inboundId: string, context: Context): Promise<CycleOutcome> {
    try {
      return await pollCycle(this.#dependencies, inboundId, context);
    } catch (error) {
      logFailure(
        this.#dependencies.logger,
        inboundId,
        error instanceof CodedError ? error.code : UNKNOWN_CODE,
      );
      return CycleOutcome.Continue;
    }
  }
}
