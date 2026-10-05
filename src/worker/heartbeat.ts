import assert from "node:assert/strict";

export const HEARTBEAT_SWEEP_INTERVAL_MS = 30000;
export const MILLISECONDS_PER_SECOND = 1000;
const MINIMUM_NONNEGATIVE = 0;

export class HeartbeatClock {
  private readonly readings = new Map<string, number>();
  private readonly now: () => number;
  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }
  set(runtimeIdentity: string): void {
    const now = this.now();
    assert.ok(runtimeIdentity);
    assert.ok(Number.isFinite(now) && now >= MINIMUM_NONNEGATIVE);
    this.readings.set(runtimeIdentity, now);
  }
  renew(runtimeIdentity: string): void {
    assert.ok(runtimeIdentity);
    if (!this.readings.has(runtimeIdentity)) return;
    assert.ok(this.ageMs(runtimeIdentity)! >= MINIMUM_NONNEGATIVE);
    this.set(runtimeIdentity);
  }
  drop(runtimeIdentity: string): void {
    assert.ok(runtimeIdentity);
    this.readings.delete(runtimeIdentity);
    assert.ok(!this.readings.has(runtimeIdentity));
  }
  ageMs(runtimeIdentity: string): number | null {
    assert.ok(runtimeIdentity);
    const reading = this.readings.get(runtimeIdentity);
    if (reading === undefined) return null;
    const age = this.now() - reading;
    assert.ok(Number.isFinite(age) && age >= MINIMUM_NONNEGATIVE);
    return age;
  }
  expired(windowSeconds: number): string[] {
    assert.ok(
      Number.isSafeInteger(windowSeconds) &&
        windowSeconds > MINIMUM_NONNEGATIVE,
    );
    const now = this.now();
    assert.ok(Number.isFinite(now) && now >= MINIMUM_NONNEGATIVE);
    return [...this.readings]
      .filter(
        ([, reading]) =>
          now - reading > windowSeconds * MILLISECONDS_PER_SECOND,
      )
      .map(([identity]) => identity);
  }
  identities(): string[] {
    assert.ok(Number.isSafeInteger(this.readings.size));
    assert.ok(this.readings.size >= MINIMUM_NONNEGATIVE);
    return [...this.readings.keys()];
  }
}
