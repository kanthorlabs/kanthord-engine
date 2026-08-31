export type Composition = "single" | "composed" | "self-managed";

export const compositions: readonly ["single", "composed", "self-managed"] = [
  "single",
  "composed",
  "self-managed",
] as const;

export type WorkerEntry = Readonly<{
  worker: string;
  driver: "internal" | "external";
  agents: readonly string[];
  claims: readonly string[];
  deliverables: readonly string[];
  harness: string | null;
  metadata: { composition: Composition };
}>;

export const workerRegistry: readonly [WorkerEntry, WorkerEntry] = [
  {
    worker: "claude@1",
    driver: "external",
    agents: [],
    claims: ["objective", "task"],
    deliverables: ["test", "implementation", "review"],
    harness: "claude-code",
    metadata: { composition: "self-managed" },
  },
  {
    worker: "opencode@1",
    driver: "external",
    agents: [],
    claims: ["objective", "task"],
    deliverables: ["test", "implementation", "review"],
    harness: "opencode",
    metadata: { composition: "self-managed" },
  },
] as const;
