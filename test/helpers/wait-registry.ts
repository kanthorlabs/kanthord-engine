import {
  createWaitRegistry,
  POLL_INTERVAL_MS,
} from "../../src/http/server/event/wait.ts";
import type {
  WaitInput,
  WaitRegistry,
  WaitRegistryDependencies,
} from "../../src/http/server/event/wait.ts";
import { createFakeSchedule } from "./virtual-clock.ts";
import type { FakeSchedule } from "./virtual-clock.ts";

export { POLL_INTERVAL_MS };
export { createWaitRegistry };
export type { WaitInput, WaitRegistry, WaitRegistryDependencies };

export type TestWaits = Readonly<{
  waits: WaitRegistry;
  clock: FakeSchedule;
}>;

export function createTestWaits(): TestWaits {
  const clock = createFakeSchedule();
  return { waits: createWaitRegistry({ schedule: clock.schedule }), clock };
}

export function noopWaits(): WaitRegistry {
  return {
    wait: () => Promise.resolve([]),
    cancelAll: () => {},
  };
}
