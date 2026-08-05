import type { RefUpdateInput, RefUpdateResult } from "./index.ts";
import type { GitRunner } from "./run.ts";

export const OBSERVED_OID_PATTERN: RegExp =
  /\bis at ([0-9a-f]{40}) but expected /;

export function parseObservedOid(stderr: string): string | null {
  return OBSERVED_OID_PATTERN.exec(stderr)?.[1] ?? null;
}

export async function refUpdate(
  runner: GitRunner,
  input: RefUpdateInput,
): Promise<RefUpdateResult> {
  const result = await runner({
    args: [
      `--git-dir=${input.gitDir}`,
      "update-ref",
      input.ref,
      input.nextOid,
      input.expectedOid ?? "",
    ],
    pidFile: input.pidFile,
  });
  if (result.code === 0) {
    return { updated: true, oid: input.nextOid };
  }
  return { updated: false, observedOid: parseObservedOid(result.stderr) };
}
