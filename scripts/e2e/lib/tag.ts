import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { RunnerError } from "./errors.ts";

export type ScenarioId = "P1-E1" | "P1-E2" | "P1-E3" | "P1-E4";

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
