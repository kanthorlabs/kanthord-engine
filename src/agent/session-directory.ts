import { join } from "node:path";
import { ensureDirectory } from "../kernel/files.ts";
import { identitySchema } from "../kernel/identity.ts";

export function executionSessionDirectory(
  sessionRoot: string,
  executionId: string,
): string {
  const directory = join(
    sessionRoot,
    identitySchema("execution").parse(executionId),
  );
  ensureDirectory(directory);
  return directory;
}
