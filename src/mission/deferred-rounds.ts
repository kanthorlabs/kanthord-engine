import assert from "node:assert/strict";

export const IMMEDIATE_DELAY_MS = 0;
const NO_ROUNDS = 0;

export class DeferredRounds {
  readonly #rounds = new Set<Promise<void>>();
  readonly #timers = new Set<NodeJS.Timeout | NodeJS.Immediate>();
  #quiescent = false;

  get quiescent(): boolean {
    return this.#quiescent;
  }

  admit(round: Promise<void>): void {
    const tracked = round.finally(() => this.#rounds.delete(tracked));
    this.#rounds.add(tracked);
  }

  arm(delayMs: number, run: () => void): void {
    assert.ok(Number.isSafeInteger(delayMs) && delayMs >= IMMEDIATE_DELAY_MS);
    if (this.#quiescent) return;
    const fire = () => {
      this.#timers.delete(timer);
      run();
    };
    const timer =
      delayMs === IMMEDIATE_DELAY_MS
        ? setImmediate(fire)
        : setTimeout(fire, delayMs);
    timer.unref();
    this.#timers.add(timer);
  }

  quiesce(): void {
    this.#quiescent = true;
    for (const timer of this.#timers) timer[Symbol.dispose]();
    this.#timers.clear();
  }

  async drain(): Promise<void> {
    assert.ok(this.#quiescent, "A drain follows the quiescence.");
    await Promise.all([...this.#rounds]);
    assert.equal(this.#rounds.size, NO_ROUNDS, "Every round ends.");
  }
}
