import { setImmediate as yieldTurn } from "node:timers/promises";
import type { Logger } from "pino";
import type { HumanActor } from "../kernel/actor.ts";
import type { ServiceIdentity } from "../kernel/caller.ts";
import {
  type OwnerDeleteAnswer,
  ownerDeleteAnswerSchema,
} from "../kernel/cleanup.ts";
import { createIdempotencyKey } from "../kernel/identity.ts";
import {
  type ClientOptions,
  type Operation,
  type OperationResult,
  OperationResultType,
} from "../kernel/operation.ts";
import type { Store } from "../kernel/store.ts";
import {
  type CleanableKind,
  type CleanupOutcome,
  CleanupState,
  FOOTPRINT_CLEANUP_BATCH_ROWS,
} from "./contract.ts";
import {
  cleanupOf,
  openCleanups,
  resumeIndex,
  type StoredCleanup,
  updateCleanup,
} from "./cleanup-store.ts";

const CLEANUP_FAILED = "footprint.cleanup.failed";
const CLEANUP_ENDED = "footprint.cleanup.ended";

export interface DeleteCall {
  readonly cleanup_id: string;
  readonly instance_name: string | null;
  readonly keys: readonly string[];
  readonly requested_by: HumanActor;
}

export interface DeleteAnswer extends OwnerDeleteAnswer {
  readonly removed_bytes: number | null;
}

export type CleanupDeleter = (call: DeleteCall) => Promise<DeleteAnswer>;

export type InvokeOperation = (
  operation: Operation,
  input: unknown,
  options: ClientOptions,
) => Promise<OperationResult<unknown>>;

export class OwnerRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function ownerDeleter(
  invoke: InvokeOperation,
  identity: ServiceIdentity,
  operation: Operation,
  keysField: string,
): CleanupDeleter {
  return async (call) => {
    const result = await invoke(
      operation,
      {
        params: {},
        query: {},
        body: { [keysField]: [...call.keys], requested_by: call.requested_by },
      },
      { identity, idempotencyKey: createIdempotencyKey() },
    );
    if (result.type === OperationResultType.Failure)
      throw new OwnerRefusal(
        result.error.error.code,
        result.error.error.message,
      );
    if (result.type !== OperationResultType.Completed)
      throw new OwnerRefusal(
        "system.operation.unknown",
        `${operation.id} answered no result.`,
      );
    return {
      ...ownerDeleteAnswerSchema.parse(result.data),
      removed_bytes: null,
    };
  };
}

export interface CleanupTaskDependencies {
  readonly store: Store;
  readonly logger: Logger;
  readonly deleters: Partial<Record<CleanableKind, CleanupDeleter>>;
  readonly now: () => number;
}

function added(
  outcome: CleanupOutcome | null,
  answer: DeleteAnswer,
): CleanupOutcome {
  const base = outcome ?? {
    removed: 0,
    removed_bytes: 0,
    absent: 0,
    refused: [],
  };
  return {
    removed: base.removed + answer.removed,
    removed_bytes:
      base.removed_bytes === null || answer.removed_bytes === null
        ? null
        : base.removed_bytes + answer.removed_bytes,
    absent: base.absent + answer.absent,
    refused: [...base.refused, ...answer.refused],
  };
}

export class CleanupTask {
  private readonly dependencies: CleanupTaskDependencies;
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(dependencies: CleanupTaskDependencies) {
    this.dependencies = dependencies;
  }

  kick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async drain(): Promise<void> {
    do {
      this.again = false;
      const open = this.dependencies.store.transaction((tx) =>
        openCleanups(tx),
      );
      for (const cleanup of open) {
        if (this.stopped) return;
        await this.run(cleanup.cleanup_id);
      }
    } while (this.again && !this.stopped);
  }

  private claim(cleanupId: string): StoredCleanup | null {
    return this.dependencies.store.transaction((tx) => {
      const cleanup = cleanupOf(tx, cleanupId);
      if (
        cleanup === null ||
        (cleanup.state !== CleanupState.Queued &&
          cleanup.state !== CleanupState.Running)
      )
        return null;
      if (cleanup.state === CleanupState.Queued)
        updateCleanup(
          tx,
          cleanupId,
          CleanupState.Running,
          cleanup.outcome,
          null,
        );
      return { ...cleanup, state: CleanupState.Running };
    });
  }

  private write(
    cleanup: StoredCleanup,
    state: CleanupState,
    outcome: CleanupOutcome | null,
  ): void {
    const finished =
      state === CleanupState.Running ? null : this.dependencies.now();
    this.dependencies.store.transaction((tx) =>
      updateCleanup(tx, cleanup.cleanup_id, state, outcome, finished),
    );
    if (state !== CleanupState.Running)
      this.dependencies.logger.info(
        {
          cleanup_id: cleanup.cleanup_id,
          kind: cleanup.kind,
          instance_name: cleanup.instance_name,
          requested_by: cleanup.requested_by.account,
          state,
          removed: outcome?.removed ?? 0,
          absent: outcome?.absent ?? 0,
          refused: outcome?.refused.length ?? 0,
        },
        CLEANUP_ENDED,
      );
  }

  private async run(cleanupId: string): Promise<void> {
    const cleanup = this.claim(cleanupId);
    if (cleanup === null) return;
    const deleter = this.dependencies.deleters[cleanup.kind];
    let outcome = cleanup.outcome;
    if (deleter === undefined) {
      this.write(cleanup, CleanupState.Failed, outcome);
      return;
    }
    try {
      const batch =
        cleanup.instance_name === null
          ? FOOTPRINT_CLEANUP_BATCH_ROWS
          : cleanup.keys.length;
      for (
        let index = resumeIndex(outcome);
        index < cleanup.keys.length;
        index = resumeIndex(outcome)
      ) {
        if (this.stopped) return;
        const keys = cleanup.keys.slice(index, index + batch);
        const answer = await deleter({
          cleanup_id: cleanup.cleanup_id,
          instance_name: cleanup.instance_name,
          keys,
          requested_by: cleanup.requested_by,
        });
        const next = added(outcome, answer);
        if (resumeIndex(next) !== index + keys.length)
          throw new OwnerRefusal(
            CLEANUP_FAILED,
            "The owner answered a result count that differs from the key count.",
          );
        outcome = next;
        this.write(cleanup, CleanupState.Running, outcome);
        await yieldTurn();
      }
      this.write(cleanup, CleanupState.Completed, outcome);
    } catch (error) {
      this.dependencies.logger.error(
        {
          cleanup_id: cleanup.cleanup_id,
          kind: cleanup.kind,
          code: error instanceof OwnerRefusal ? error.code : undefined,
        },
        CLEANUP_FAILED,
      );
      this.write(cleanup, CleanupState.Failed, outcome);
    }
  }
}
