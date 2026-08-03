import type { Clock } from "../../src/services/clock/index.ts";

export type MockClockInput = Readonly<{ start: number; step?: number }>;

export function createMockClock(input: MockClockInput): Clock {
  let calls = 0;
  return {
    now(): number {
      const result = input.start + calls * (input.step ?? 0);
      calls++;
      return result;
    },
  };
}
