export const DAY_MS = 86400000;

export function writableCutoff(now: number, writableDays: number): number {
  return now - writableDays * DAY_MS;
}
