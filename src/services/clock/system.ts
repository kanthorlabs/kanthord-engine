import type { Clock } from "./index.ts";

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
