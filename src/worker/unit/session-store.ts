import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { PI_DIRECTORY_NAME } from "../../agent/pi.ts";
import { audit, ensureDirectory, FileKind } from "../../kernel/files.ts";
import { identitySchema } from "../../kernel/identity.ts";

export const EXECUTION_SESSIONS_KEPT = 50;
const SESSIONS_DIRECTORY = "sessions";
const EXECUTION_DIRECTORY = "execution";

export function executionSessionRoot(dataDirectory: string): string {
  return join(
    dataDirectory,
    PI_DIRECTORY_NAME,
    SESSIONS_DIRECTORY,
    EXECUTION_DIRECTORY,
  );
}

function pruneOlder(sessionRoot: string, keep: string): void {
  const others = readdirSync(sessionRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== keep)
    .map((entry) => ({
      path: join(sessionRoot, entry.name),
      modified: statSync(join(sessionRoot, entry.name)).mtimeMs,
    }))
    .toSorted((left, right) => right.modified - left.modified);
  for (const old of others.slice(EXECUTION_SESSIONS_KEPT - 1))
    rmSync(old.path, { recursive: true });
}

export function executionSessionDirectory(
  sessionRoot: string,
  executionId: string,
): string {
  const directory = join(
    sessionRoot,
    identitySchema("execution").parse(executionId),
  );
  const existed = audit(directory, FileKind.Directory, true);
  ensureDirectory(directory);
  if (!existed) pruneOlder(sessionRoot, executionId);
  return directory;
}
