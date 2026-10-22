import assert from "node:assert/strict";
import { addAbortListener } from "node:events";
import { CodedError } from "./errors.ts";

const EXPIRED_REMAINING_MS = 0;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface Context {
  readonly signal: AbortSignal;
  readonly deadline: number | null;
}

export class ContextCancelled extends CodedError {
  constructor() {
    super("system.context.cancelled", "Context cancelled.");
  }
}

export class DeadlineExceeded extends CodedError {
  constructor() {
    super("system.context.deadline_exceeded", "Context deadline exceeded.");
  }
}

export const background: Context = Object.freeze({
  signal: new AbortController().signal,
  deadline: null,
});

export class CancellationContext implements Context {
  readonly signal: AbortSignal;
  readonly deadline: number | null;
  private readonly controller = new AbortController();
  private timer?: NodeJS.Timeout;

  constructor(parent: Context = background, deadline: number | null = null) {
    if (deadline !== null && !Number.isSafeInteger(deadline))
      throw new TypeError("Context deadline must be Unix milliseconds.");
    const inherited = parent.deadline;
    this.deadline = earlier(inherited, deadline);
    this.signal = AbortSignal.any([parent.signal, this.controller.signal]);
    if (this.signal.aborted) return;
    if (deadline !== null && (inherited === null || deadline < inherited))
      this.armDeadline();
    else if (this.deadline !== null && this.deadline <= Date.now())
      this.cancel(new DeadlineExceeded());
  }

  cancel(reason: Error = new ContextCancelled()): void {
    this.controller.abort(reason);
  }

  private armDeadline(): void {
    addAbortListener(this.signal, () => clearTimeout(this.timer));
    this.scheduleDeadline();
  }

  private scheduleDeadline(): void {
    if (this.deadline === null || this.signal.aborted) return;
    const remaining = this.deadline - Date.now();
    if (remaining <= EXPIRED_REMAINING_MS)
      return this.cancel(new DeadlineExceeded());
    this.timer = setTimeout(
      () => this.scheduleDeadline(),
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
    this.timer.unref();
  }
}

export function cancelled(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    addAbortListener(signal, () => resolve());
  });
}

export function reasonOf(signal: AbortSignal): Error | null {
  if (!signal.aborted) return null;
  assert.ok(
    signal.reason instanceof Error,
    "An aborted signal holds an error.",
  );
  return signal.reason;
}

export function joined(first: Context, second: Context): Context {
  return {
    signal: AbortSignal.any([first.signal, second.signal]),
    deadline: earlier(first.deadline, second.deadline),
  };
}

function earlier(first: number | null, second: number | null): number | null {
  if (first === null) return second;
  if (second === null) return first;
  return Math.min(first, second);
}
