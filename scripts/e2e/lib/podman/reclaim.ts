import type { PodmanExecutor } from "../driver/podman.ts";
import type { ResourceKind } from "../resources.ts";

export const runLabel = "kanthord-e2e-run";

type Kind = Extract<
  ResourceKind,
  "container" | "pod" | "secret" | "volume" | "network" | "image"
>;

export type ReclaimOutcome = Readonly<{ kind: ResourceKind; id: string }>;

export type ReclaimReport = Readonly<{
  reclaimed: readonly ReclaimOutcome[];
  failed: readonly ReclaimOutcome[];
}>;

type Plan = Readonly<{
  kind: Kind;
  list: (filterFlag: string) => readonly string[];
  remove: (filterFlag: string, ids: readonly string[]) => readonly string[];
}>;

const plans: readonly Plan[] = [
  {
    kind: "container",
    list: (filterFlag) => [
      "podman",
      "ps",
      "--all",
      "--quiet",
      "--filter",
      filterFlag,
    ],
    remove: (filterFlag) => ["podman", "rm", "--force", "--filter", filterFlag],
  },
  {
    kind: "pod",
    list: (filterFlag) => [
      "podman",
      "pod",
      "ps",
      "--quiet",
      "--filter",
      filterFlag,
    ],
    remove: (_filterFlag, ids) => ["podman", "pod", "rm", "--force", ...ids],
  },
  {
    kind: "secret",
    list: (filterFlag) => [
      "podman",
      "secret",
      "ls",
      "--quiet",
      "--filter",
      filterFlag,
    ],
    remove: (_filterFlag, ids) => ["podman", "secret", "rm", ...ids],
  },
  {
    kind: "volume",
    list: (filterFlag) => [
      "podman",
      "volume",
      "ls",
      "--quiet",
      "--filter",
      filterFlag,
    ],
    remove: (_filterFlag, ids) => ["podman", "volume", "rm", "--force", ...ids],
  },
  {
    kind: "network",
    list: (filterFlag) => [
      "podman",
      "network",
      "ls",
      "--quiet",
      "--filter",
      filterFlag,
    ],
    remove: (_filterFlag, ids) => [
      "podman",
      "network",
      "rm",
      "--force",
      ...ids,
    ],
  },
  {
    kind: "image",
    list: (filterFlag) => [
      "podman",
      "image",
      "ls",
      "--quiet",
      "--filter",
      filterFlag,
    ],
    remove: (_filterFlag, ids) => ["podman", "image", "rm", "--force", ...ids],
  },
];

function parseIds(stdout: string): readonly string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export type ReclaimFailureDetail = Readonly<{
  exitCode: number | null;
  stderr: string;
}>;

export type ReclaimFailureReporter = (
  kind: Kind,
  detail: ReclaimFailureDetail,
) => void;

export async function reclaimByLabel(
  execute: PodmanExecutor,
  runId: string,
  onRemoveFailure?: ReclaimFailureReporter,
): Promise<ReclaimReport> {
  const filterFlag = `label=${runLabel}=${runId}`;
  const reclaimed: ReclaimOutcome[] = [];
  const failed: ReclaimOutcome[] = [];

  for (const plan of plans) {
    const listRecord = await execute(plan.list(filterFlag));
    const ids = parseIds(listRecord.stdout);
    if (ids.length === 0) {
      continue;
    }

    let lastFailure: ReclaimFailureDetail | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const removeRecord = await execute(plan.remove(filterFlag, ids));
        if (removeRecord.exitCode === 0) {
          lastFailure = null;
          break;
        }
        lastFailure = {
          exitCode: removeRecord.exitCode,
          stderr: removeRecord.stderr,
        };
      } catch (error) {
        lastFailure = { exitCode: null, stderr: (error as Error).message };
      }
    }

    const verifyRecord = await execute(plan.list(filterFlag));
    const surviving = new Set(parseIds(verifyRecord.stdout));
    let anySurvived = false;
    for (const id of ids) {
      if (surviving.has(id)) {
        anySurvived = true;
        failed.push({ kind: plan.kind, id });
      } else {
        reclaimed.push({ kind: plan.kind, id });
      }
    }

    if (anySurvived && lastFailure !== null) {
      onRemoveFailure?.(plan.kind, lastFailure);
    }
  }

  return { reclaimed, failed };
}
