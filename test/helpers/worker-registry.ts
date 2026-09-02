import type { WorkerEntry } from "../../src/domain/worker-registry.ts";

export const expansionCapableRegistry: readonly WorkerEntry[] = [
  {
    worker: "claude@1",
    driver: "external",
    agents: [],
    claims: ["initiative", "objective", "task"],
    deliverables: ["test", "implementation", "review", "expansion"],
    harness: "claude-code",
    metadata: { composition: "self-managed" },
  },
];
