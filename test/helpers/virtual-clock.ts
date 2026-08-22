import type { Schedule } from "../../src/http/server/idempotency-store.ts";

export type Armed = {
  dueAt: number;
  run: () => void;
  fired: boolean;
  cancelCalls: number;
};

export type FakeSchedule = Readonly<{
  schedule: Schedule;
  armed: Armed[];
  advanceBy(milliseconds: number): void;
  now(): number;
}>;

export function createFakeSchedule(): FakeSchedule {
  let now = 0;
  const armed: Armed[] = [];
  const schedule: Schedule = (milliseconds, callback) => {
    const entry: Armed = {
      dueAt: now + milliseconds,
      run: callback,
      fired: false,
      cancelCalls: 0,
    };
    armed.push(entry);
    return () => {
      entry.cancelCalls += 1;
    };
  };
  const advanceBy = (milliseconds: number): void => {
    now += milliseconds;
    for (const entry of [...armed]) {
      if (!entry.fired && entry.cancelCalls === 0 && entry.dueAt <= now) {
        entry.fired = true;
        entry.run();
      }
    }
  };
  return { schedule, armed, advanceBy, now: () => now };
}
