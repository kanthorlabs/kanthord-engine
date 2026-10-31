import type { TestContext } from "node:test";

const SINGLE_FAILURE = 1;
const stopFailures = new WeakMap<TestContext, unknown[]>();

export function stopAfter(t: TestContext, stop: () => unknown): void {
  t.after(async () => {
    try {
      await stop();
    } catch (error) {
      const failures = stopFailures.get(t);
      if (!failures) {
        const recorded = [error];
        stopFailures.set(t, recorded);
        t.after(() => {
          throw recorded.length === SINGLE_FAILURE
            ? recorded[0]
            : new AggregateError(recorded, "Test stops failed.");
        });
      } else failures.push(error);
    }
  });
}
