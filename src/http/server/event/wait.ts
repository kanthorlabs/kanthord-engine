import type { Schedule } from "../idempotency-store.ts";

export const POLL_INTERVAL_MS = 250;

export type WaitInput<T> = Readonly<{
  read: () => readonly T[];
  waitSeconds: number;
}>;

export type WaitRegistry = Readonly<{
  wait<T>(input: WaitInput<T>): Promise<readonly T[]>;
  cancelAll(): void;
}>;

export type WaitRegistryDependencies = Readonly<{
  schedule: Schedule;
}>;

type Registration = {
  remainingTicks: number;
  cancelTimer: (() => void) | undefined;
  settled: boolean;
  resolveEmpty: () => void;
};

export function createWaitRegistry(
  dependencies: WaitRegistryDependencies,
): WaitRegistry {
  const pending: Registration[] = [];

  const withdraw = (registration: Registration): void => {
    registration.cancelTimer?.();
    const at = pending.indexOf(registration);
    if (at >= 0) pending.splice(at, 1);
  };

  return {
    wait<T>(input: WaitInput<T>): Promise<readonly T[]> {
      const totalTicks = Math.floor(
        (input.waitSeconds * 1000) / POLL_INTERVAL_MS,
      );
      let started: readonly T[];
      try {
        started = input.read();
      } catch (error) {
        return Promise.reject(error);
      }
      if (started.length > 0) {
        return Promise.resolve(started);
      }
      if (totalTicks <= 0) {
        return Promise.resolve([]);
      }
      let resolve!: (rows: readonly T[]) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<readonly T[]>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      let registration!: Registration;
      const finish = (rows: readonly T[]): void => {
        if (registration.settled) return;
        registration.settled = true;
        withdraw(registration);
        resolve(rows);
      };
      const abort = (error: unknown): void => {
        if (registration.settled) return;
        registration.settled = true;
        withdraw(registration);
        reject(error);
      };
      const runTick = (): void => {
        if (registration.settled) return;
        registration.remainingTicks -= 1;
        let rows: readonly T[];
        try {
          rows = input.read();
        } catch (error) {
          abort(error);
          return;
        }
        if (rows.length > 0) {
          finish(rows);
          return;
        }
        if (registration.remainingTicks > 0) {
          registration.cancelTimer = dependencies.schedule(
            POLL_INTERVAL_MS,
            runTick,
          );
          return;
        }
        finish([]);
      };
      registration = {
        remainingTicks: totalTicks,
        cancelTimer: undefined,
        settled: false,
        resolveEmpty: () => finish([]),
      };
      pending.push(registration);
      registration.cancelTimer = dependencies.schedule(
        POLL_INTERVAL_MS,
        runTick,
      );
      return promise;
    },
    cancelAll(): void {
      for (const registration of [...pending]) {
        registration.resolveEmpty();
      }
    },
  };
}
