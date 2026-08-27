import type { Schedule } from "../../idempotency-store.ts";

export const systemSchedule: Schedule = (milliseconds, callback) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};
