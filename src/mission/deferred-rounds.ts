import assert from "node:assert/strict";

export const IMMEDIATE_DELAY_MS = 0;
const NO_ROUNDS = 0;

export class DeferredRounds {
  readonly #rounds = new Set<Promise<void>>();
  readonly #timers = new Set<() => void>();
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
      this.#timers.delete(cancel);
      run();
    };
    let cancel: () => void;
    if (delayMs === IMMEDIATE_DELAY_MS) {
      const immediate = setImmediate(fire).unref();
      cancel = () => clearImmediate(immediate);
    } else {
      const timeout = setTimeout(fire, delayMs).unref();
      cancel = () => clearTimeout(timeout);
    }
    this.#timers.add(cancel);
  }

  quiesce(): void {
    this.#quiescent = true;
    for (const cancel of this.#timers) cancel();
    this.#timers.clear();
  }

  async drain(): Promise<void> {
    assert.ok(this.#quiescent, "A drain follows the quiescence.");
    await Promise.all([...this.#rounds]);
    assert.equal(this.#rounds.size, NO_ROUNDS, "Every round ends.");
  }
}
