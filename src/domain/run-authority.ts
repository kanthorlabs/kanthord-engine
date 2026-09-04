export const runAuthorityRefusals = [
  "run-not-found",
  "run-ended",
  "run-expired",
  "run-caller-mismatch",
  "target-outside-run",
  "fence-stale",
] as const;

export type RunAuthorityRefusalCode = (typeof runAuthorityRefusals)[number];

export type AuthorityRun = Readonly<{
  id: string;
  nodeId: string;
  state: "active" | "ended";
  fence: number | null;
  expiresAt: number | null;
  worker: string | null;
}>;

export type RunAuthorityInput = Readonly<{
  run: AuthorityRun | null;
  runId: string;
  fence: number;
  targetNodeId: string;
  subtreeIds: readonly string[];
  caller: string;
  now: number;
}>;

export type RunAuthorityRefusal = Readonly<{
  refusal: RunAuthorityRefusalCode;
  runId: string;
}>;

export function assertRunAuthority(
  input: RunAuthorityInput,
): RunAuthorityRefusal | null {
  const run = input.run;

  if (run === null || run.id !== input.runId) {
    return { refusal: "run-not-found", runId: input.runId };
  }

  if (run.state !== "active") {
    return { refusal: "run-ended", runId: input.runId };
  }

  if (run.expiresAt !== null && run.expiresAt <= input.now) {
    return { refusal: "run-expired", runId: input.runId };
  }

  if (run.worker !== input.caller) {
    return { refusal: "run-caller-mismatch", runId: input.runId };
  }

  if (
    input.targetNodeId !== run.nodeId &&
    !input.subtreeIds.includes(input.targetNodeId)
  ) {
    return { refusal: "target-outside-run", runId: input.runId };
  }

  if (run.fence !== input.fence) {
    return { refusal: "fence-stale", runId: input.runId };
  }

  return null;
}
