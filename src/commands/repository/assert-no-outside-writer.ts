import type { EventLog } from "../../services/event/index.ts";
import type { Git } from "../../services/git/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

export type AdoptRepositoryDependencies = Readonly<{
  storage: Storage;
  events: EventLog;
  git: Git;
}>;

export type AdoptRepositoryInput = Readonly<{
  repositoryId: string;
  gitDir: string;
  ref: string;
  intent: "merge" | "sync" | "publish" | "revert";
  actor: string;
}>;

export type AdoptVerdict = Readonly<{
  expected: boolean;
  expectedOid: string | null;
  observedOid: string | null;
}>;

const LAST_COMPLETED_SQL: string = `SELECT result_head_oid FROM git_operation
WHERE repository_id = ? AND ref = ? AND intent = ?
  AND state = 'complete' AND result_head_oid IS NOT NULL
ORDER BY completed_at DESC, id DESC
LIMIT 1`;

function lastCompletedOid(
  transaction: Transaction,
  input: Pick<AdoptRepositoryInput, "repositoryId" | "ref" | "intent">,
): string | null {
  const row: unknown = transaction.get(LAST_COMPLETED_SQL, [
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

export async function assertNoOutsideWriter(
  dependencies: AdoptRepositoryDependencies,
  input: AdoptRepositoryInput,
): Promise<AdoptVerdict> {
  const observedOid = await dependencies.git.resolveRef({
    gitDir: input.gitDir,
    ref: input.ref,
  });
  return dependencies.storage.transact((transaction) => {
    const expectedOid = lastCompletedOid(transaction, input);
    if (expectedOid === observedOid) {
      return { expected: true, expectedOid, observedOid };
    }
    dependencies.events.append(transaction, {
      subjectKind: "repository",
      subjectId: input.repositoryId,
      type: "repository.outsideWriter",
      actorKind: "human",
      actorId: input.actor,
      payload: {
        ref: input.ref,
        intent: input.intent,
        expectedOid,
        observedOid,
      },
    });
    return { expected: false, expectedOid, observedOid };
  });
}
