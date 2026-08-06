import type { Transaction } from "../../services/storage/index.ts";

export type RepositoryWorkVerdict =
  | Readonly<{ accepts: true }>
  | Readonly<{
      accepts: false;
      reason: "publish-reconcile-pending";
      gitOperationId: string;
    }>;

export const OPEN_PUBLISH_SQL =
  "SELECT id FROM git_operation WHERE repository_id = ? AND intent = 'publish' AND state = 'open' ORDER BY id LIMIT 1";

export function assertRepositoryAcceptsWork(
  transaction: Transaction,
  input: Readonly<{ repositoryId: string }>,
): RepositoryWorkVerdict {
  const row = transaction.get(OPEN_PUBLISH_SQL, [input.repositoryId]) as
    { id: string } | undefined;
  if (row === undefined) {
    return { accepts: true };
  }
  return {
    accepts: false,
    reason: "publish-reconcile-pending",
    gitOperationId: row.id,
  };
}
