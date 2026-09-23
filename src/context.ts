import { CodedError } from "./shared/errors.ts";

const EXPIRED_REMAINING_MS = 0;

/** Go-inspired cancellation contract. Only the owner of a child can cancel it. */
export interface Context {
  deadline(): number | null;
  done(): Promise<void>;
  err(): Error | null;
  /** Called immediately if already cancelled; returns an unsubscribe function. */
  onCancel(listener: (error: Error) => void): () => void;
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

const never = new Promise<void>(() => {});
export const background: Context = Object.freeze({
  deadline: () => null,
  done: () => never,
  err: () => null,
  onCancel: () => () => {},
});

export class CancellationContext implements Context {
  private readonly completion = Promise.withResolvers<void>();
  private readonly listeners = new Set<(error: Error) => void>();
  private readonly expiresAt: number | null;
  private reason: Error | null = null;
  private unlink: () => void = () => {};
  private timer?: NodeJS.Timeout;

  constructor(parent: Context = background, deadline: number | null = null) {
    if (deadline !== null && !Number.isSafeInteger(deadline))
      throw new TypeError("Context deadline must be Unix milliseconds.");
    const inherited = parent.deadline();
    this.expiresAt =
      inherited === null
        ? deadline
        : deadline === null
          ? inherited
          : Math.min(inherited, deadline);
    this.unlink = parent.onCancel((error) => this.cancel(error));
    if (this.reason) this.unlink();
    else if (deadline !== null && (inherited === null || deadline < inherited))
      this.scheduleDeadline();
    else if (this.expiresAt !== null && this.expiresAt <= Date.now())
      this.cancel(new DeadlineExceeded());
  }

  deadline(): number | null {
    return this.expiresAt;
  }
  done(): Promise<void> {
    return this.completion.promise;
  }
  err(): Error | null {
    return this.reason;
  }

  onCancel(listener: (error: Error) => void): () => void {
    if (this.reason) this.notify(listener, this.reason);
    else this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  cancel(error: Error = new ContextCancelled()): void {
    if (this.reason) return;
    this.reason = error;
    clearTimeout(this.timer);
    this.unlink();
    this.completion.resolve();
    for (const listener of this.listeners) this.notify(listener, error);
    this.listeners.clear();
  }

  private notify(listener: (error: Error) => void, error: Error): void {
    try {
      listener(error);
    } catch (failure) {
      queueMicrotask(() => {
        throw failure;
      });
    }
  }

  private scheduleDeadline(): void {
    if (this.expiresAt === null || this.reason) return;
    const remaining = this.expiresAt - Date.now();
    if (remaining <= EXPIRED_REMAINING_MS)
      return this.cancel(new DeadlineExceeded());
    this.timer = setTimeout(
      () => this.scheduleDeadline(),
      Math.min(remaining, 2 ** 31 - 1),
    );
    this.timer.unref();
  }
}

export function throwIfCancelled(context: Context): void {
  const error = context.err();
  if (error) throw error;
}

/** Native transport bridge. Dispose after the response body has been consumed. */
export function abortSignal(context: Context): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const dispose = context.onCancel((error) => controller.abort(error));
  return { signal: controller.signal, dispose };
}
