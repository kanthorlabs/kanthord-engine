import type { OutsideWriterInput, OutsideWriterVerdict } from "./index.ts";
import { resolveRef } from "./ref-read.ts";
import type { GitRunner } from "./run.ts";

export const LAST_COMPLETED_SQL: string = `SELECT result_head_oid FROM git_operation
WHERE repository_id = ? AND ref = ? AND intent = ?
  AND state = 'complete' AND result_head_oid IS NOT NULL
ORDER BY completed_at DESC, id DESC
LIMIT 1`;

export function lastCompletedOid(
  input: Pick<
    OutsideWriterInput,
    "transaction" | "repositoryId" | "ref" | "intent"
  >,
): string | null {
  const row: unknown = input.transaction.get(LAST_COMPLETED_SQL, [
    input.repositoryId,
    input.ref,
    input.intent,
  ]);
  if (typeof row !== "object" || row === null) {
    return null;
  }
  if (!("result_head_oid" in row)) {
    return null;
  }
  const value = row.result_head_oid;
  return typeof value === "string" ? value : null;
}

export async function checkOutsideWriter(
  runner: GitRunner,
  input: OutsideWriterInput,
): Promise<OutsideWriterVerdict> {
  const expected = lastCompletedOid(input);
  const observed = await resolveRef(runner, {
    gitDir: input.gitDir,
    ref: input.ref,
  });
  if (expected === observed) {
    return { expected: true, oid: observed };
  }
  return { expected: false, expectedOid: expected, observedOid: observed };
}
