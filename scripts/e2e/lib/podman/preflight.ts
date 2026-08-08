import { RunnerError } from "../errors.ts";
import type { PodmanExecutor } from "../driver/podman.ts";

export const minimumPodmanVersion = "5.0.0";
export const baseImageReference =
  "docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584";

export type PodmanFacts = Readonly<{
  version: string;
  rootless: boolean;
  architecture: string;
}>;

const versionPattern = /^(\d+)\.(\d+)\.(\d+)/;

function parseVersion(text: string): readonly [number, number, number] {
  const match = versionPattern.exec(text);
  if (match === null) {
    throw new RunnerError(
      "unavailable",
      `podman reported an unreadable version: ${text}`,
    );
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isBelowMinimum(
  found: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    const foundPart = found[index] as number;
    const minimumPart = minimum[index] as number;
    if (foundPart !== minimumPart) {
      return foundPart < minimumPart;
    }
  }
  return false;
}

export async function assertPodman(
  execute: PodmanExecutor,
): Promise<PodmanFacts> {
  let versionOutput: string;
  try {
    const record = await execute([
      "podman",
      "version",
      "--format",
      "{{.Client.Version}}",
    ]);
    if (record.exitCode !== 0) {
      throw new Error(`podman version exited ${record.exitCode}`);
    }
    versionOutput = record.stdout.trim();
  } catch {
    throw new RunnerError(
      "unavailable",
      "podman is not reachable; install podman and, on macOS, run: podman machine start",
    );
  }

  const found = parseVersion(versionOutput);
  const minimum = parseVersion(minimumPodmanVersion);
  if (isBelowMinimum(found, minimum)) {
    throw new RunnerError(
      "unavailable",
      `podman ${versionOutput} is below the tested minimum ${minimumPodmanVersion}`,
    );
  }

  let infoOutput: string;
  try {
    const record = await execute([
      "podman",
      "info",
      "--format",
      "{{.Host.Security.Rootless}} {{.Host.Arch}}",
    ]);
    if (record.exitCode !== 0) {
      throw new Error(`podman info exited ${record.exitCode}`);
    }
    infoOutput = record.stdout.trim();
  } catch {
    throw new RunnerError(
      "unavailable",
      "podman is installed but not running; start it with: podman machine start",
    );
  }

  const [rootlessText, architecture] = infoOutput.split(/\s+/);

  return {
    version: versionOutput,
    rootless: rootlessText === "true",
    architecture: architecture ?? "",
  };
}
