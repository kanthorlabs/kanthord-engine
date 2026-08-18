import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { RunnerError } from "./errors.ts";

export type ScenarioId =
  "P1-E1" | "P1-E2" | "P1-E4" | "P1-E5" | "P1B-E1" | "P1B-E2" | "P1B-E3";

export const runRoot = ".data";

export function mintTag(now: Date, entropy: () => string): string {
  const timestamp = now.toISOString().replaceAll(/[-:.TZ]/g, "");
  return `${timestamp}-${entropy()}`.toLowerCase();
}

export function runDirectory(tag: string): string {
  return `${runRoot}/acceptance-${tag}`;
}

export function bundleDirectory(tag: string, scenarioId: ScenarioId): string {
  return join(runDirectory(tag), scenarioId);
}

export function verifyRecordPath(tag: string): string {
  return join(runDirectory(tag), "verify.json");
}

export function acceptanceRecordPath(tag: string): string {
  return join(runDirectory(tag), "acceptance.json");
}

export async function claimBundleDirectory(
  tag: string,
  scenarioId: ScenarioId,
): Promise<string> {
  await mkdir(runDirectory(tag), { recursive: true });

  const directory = bundleDirectory(tag, scenarioId);

  try {
    await mkdir(directory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new RunnerError(
        "tag-reused",
        `tag ${tag} already holds a run of ${scenarioId}`,
      );
    }

    throw error;
  }

  return directory;
}
