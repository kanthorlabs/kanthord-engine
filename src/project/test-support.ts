import assert from "node:assert/strict";
import type { EnvironmentAgent } from "./environment-agent.ts";
import type { EnvironmentProbeRunner } from "./environment-probe-contract.ts";
import { type EnvironmentRuntime, ProofOutcome } from "./environment-state.ts";
import { EnvironmentFailureClass, FailureOrigin } from "./contract.ts";
import type { GroupRecord } from "./onboarding.ts";
import type { ProjectService } from "./service.ts";

const MILLISECONDS_PER_SECOND = 1000;
const PENDING_SECONDS = 900;
const SEEDED_FAILURE_COMMAND = "pnpm install";
const SEEDED_FAILURE_TAIL = "pnpm: command failed";
const SEEDED_FAILURE_EXIT_CODE = 1;
const SEEDED_DIGEST = "seeded-digest";
const SEEDED_COMMIT = "seeded-commit";
const SEEDED_PENDING_REASON = "The repository read has not completed.";

export function inertEnvironmentRuntime(): EnvironmentRuntime {
  return {
    runtimeName: "podman",
    imageId: async () => null,
    pullImage: async () => {},
    imageExists: async () => false,
    build: async () => ({ outcome: "built" }),
    prove: async () => [],
    proveOnHost: async () => [],
    tagProved: async () => {},
    removeTags: async () => {},
    collect: async () => {},
    removeStaleRuns: async () => {},
    cacheVolumes: async () => [],
    removeCacheVolume: async () => {},
    footprintUsage: async () => ({
      usage: { runtime: "podman", images: [], volumes: [] },
      owned_image_ids: [],
      cache_volumes: [],
    }),
    removeImage: async () => false,
  };
}

export function inertEnvironmentAgent(): Pick<
  EnvironmentAgent,
  "enabled" | "run"
> {
  return { enabled: () => false, run: async () => "not_enabled" };
}

export function inertEnvironmentProbe(): EnvironmentProbeRunner {
  return { run: async () => ({ image: null, exit_code: null, output: "" }) };
}

async function settledRecord(
  project: ProjectService,
  projectId: string,
  bindingId: string,
): Promise<GroupRecord> {
  await project.rebuildEnvironment(projectId, bindingId);
  const record = Array.from(project["onboarding"]["records"].values()).find(
    (candidate) =>
      candidate.project_id === projectId && candidate.binding_id === bindingId,
  );
  assert.ok(record, "The binding holds an environment record.");
  return record;
}

export async function seedEnvironmentFailed(
  project: ProjectService,
  projectId: string,
  bindingId: string,
): Promise<void> {
  const record = await settledRecord(project, projectId, bindingId);
  record.read_succeeded = true;
  record.reason = null;
  record.reason_started_at = null;
  record.proof = {
    digest: record.digest ?? SEEDED_DIGEST,
    outcome: ProofOutcome.Failed,
    class: EnvironmentFailureClass.SetupFailed,
    origin: FailureOrigin.Onboarding,
    execution_id: null,
    command: SEEDED_FAILURE_COMMAND,
    exit_code: SEEDED_FAILURE_EXIT_CODE,
    tail: SEEDED_FAILURE_TAIL,
    reproduce: null,
    checks: [],
    repairs: 0,
    ended_at: Date.now(),
    commit: record.commit ?? SEEDED_COMMIT,
  };
}

export async function seedEnvironmentPending(
  project: ProjectService,
  projectId: string,
  bindingId: string,
): Promise<void> {
  const record = await settledRecord(project, projectId, bindingId);
  record.read_succeeded = false;
  record.proof = null;
  record.reason = SEEDED_PENDING_REASON;
  record.reason_started_at =
    Date.now() - PENDING_SECONDS * MILLISECONDS_PER_SECOND;
}
