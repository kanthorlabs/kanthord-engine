import { setTimeout as delay } from "node:timers/promises";
import { Diagnostic } from "../../kernel/errors.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";
import { SESSION_READ_WAIT_MS } from "../../tracking/contract.ts";
import type {
  SessionReadEntry,
  SessionReadResult,
} from "../../worker/contract.ts";
import { readSessionFileEntry } from "../../worker/unit/index.ts";
import {
  EXCHANGE_UNAVAILABLE,
  INSTANCE_REPORT_RETRY_MS,
} from "./instance-exchange.ts";

export type SessionReadReporter = (
  readId: string,
  result: SessionReadResult,
  idempotencyKey: string,
) => Promise<void>;

export interface SessionReadsOptions {
  sessionRoot: string;
  report: SessionReadReporter;
  signal: AbortSignal;
  retryMs?: number;
  log: (record: Record<string, unknown>) => void;
}

function codeOf(error: unknown): string | null {
  return error instanceof Diagnostic ? error.code : null;
}

export class SessionReads {
  private readonly options: SessionReadsOptions;
  private readonly taken = new Set<string>();

  constructor(options: SessionReadsOptions) {
    this.options = options;
  }

  sync(entries: readonly SessionReadEntry[]): void {
    if (this.options.signal.aborted) return;
    const listed = new Set(entries.map((entry) => entry.read_id));
    for (const id of this.taken) if (!listed.has(id)) this.taken.delete(id);
    for (const entry of entries) {
      if (this.taken.has(entry.read_id)) continue;
      this.taken.add(entry.read_id);
      void this.run(entry);
    }
  }

  private async run({ read_id, ...read }: SessionReadEntry): Promise<void> {
    const deadline = Date.now() + SESSION_READ_WAIT_MS;
    let result: SessionReadResult;
    try {
      result = await readSessionFileEntry(
        this.options.sessionRoot,
        read,
        AbortSignal.any([
          this.options.signal,
          AbortSignal.timeout(SESSION_READ_WAIT_MS),
        ]),
      );
    } catch (error) {
      this.options.log({
        msg: "Worker instance session read failed",
        read_id,
        code: codeOf(error),
      });
      return;
    }
    const idempotencyKey = createIdempotencyKey();
    for (;;) {
      try {
        await this.options.report(read_id, result, idempotencyKey);
        return;
      } catch (error) {
        if (!this.retryable(error, deadline)) {
          this.options.log({
            msg: "Worker instance session read report failed",
            read_id,
            outcome: result.outcome,
            code: codeOf(error),
          });
          return;
        }
      }
      try {
        await delay(
          this.options.retryMs ?? INSTANCE_REPORT_RETRY_MS,
          undefined,
          { signal: this.options.signal },
        );
      } catch {
        return;
      }
    }
  }

  private retryable(error: unknown, deadline: number): boolean {
    return (
      codeOf(error) === EXCHANGE_UNAVAILABLE &&
      !this.options.signal.aborted &&
      Date.now() < deadline
    );
  }
}
