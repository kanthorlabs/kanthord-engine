import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export function pidFilePathFor(
  runDirectory: string,
  gitOperationId: string,
): string {
  return join(runDirectory, `gitop-${gitOperationId}.pid`);
}

export async function listPidFiles(
  input: Readonly<{ runDirectory: string }>,
): Promise<readonly string[]> {
  let entries;
  try {
    entries = readdirSync(input.runDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".pid"))
    .map((entry) => join(input.runDirectory, entry.name))
    .sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
}

export async function removePidFile(
  input: Readonly<{ pidFile: string }>,
): Promise<void> {
  rmSync(input.pidFile, { force: true });
}
