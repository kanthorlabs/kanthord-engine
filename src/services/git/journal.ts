import type { Transaction } from "../storage/index.ts";
import {
  JournalError,
  type GitIntent,
  type GitJournal,
  type InFlightJournalRow,
  type OpenJournalRow,
} from "./index.ts";

export function createGitJournal(): GitJournal {
  return {
    open(transaction, input) {
      transaction.run(
        "INSERT INTO git_operation (id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, child_token, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
          input.id,
          input.repositoryId,
          input.intent,
          input.nodeId,
          input.runId,
          input.candidateId,
          input.leaseFence,
          input.ref,
          input.baseOid,
          input.proposedHeadOid,
          null,
          input.expectedRemoteOid,
          "open",
          null,
          null,
          input.childToken,
          null,
        ],
      );
    },
    complete(transaction, input) {
      const token = readOpenChildToken(transaction, input.id);
      transaction.run(
        "UPDATE git_operation SET state = 'complete', result_head_oid = ?, outcome = ?, child_token = NULL, completed_at = ? WHERE id = ? AND state = 'open'",
        [input.resultHeadOid, input.outcome, input.completedAt, input.id],
      );
      return token;
    },
    discard(transaction, input) {
      const token = readOpenChildToken(transaction, input.id);
      transaction.run(
        "UPDATE git_operation SET state = 'discarded', result_head_oid = NULL, outcome = ?, child_token = NULL, completed_at = ? WHERE id = ? AND state = 'open'",
        [input.outcome, input.completedAt, input.id],
      );
      return token;
    },
    listInFlight(transaction) {
      const rows = transaction.all(
        "SELECT o.id, o.repository_id, r.home_path, o.intent, o.ref, o.base_oid, o.proposed_head_oid, o.child_token FROM git_operation o JOIN repository r ON r.id = o.repository_id WHERE o.state = 'open' AND o.child_token IS NOT NULL ORDER BY o.id",
      );
      return rows.map(mapInFlightRow);
    },
    listOpen(transaction) {
      const rows = transaction.all(
        "SELECT o.id, o.repository_id, r.home_path, o.intent, o.ref, o.base_oid, o.proposed_head_oid, o.child_token FROM git_operation o JOIN repository r ON r.id = o.repository_id WHERE o.state = 'open' ORDER BY o.id",
      );
      return rows.map(mapOpenRow);
    },
    markPublishPending(transaction, input) {
      const token = readOpenChildToken(transaction, input.id);
      transaction.run(
        "UPDATE git_operation SET outcome = ?, child_token = NULL WHERE id = ? AND state = 'open'",
        [input.outcome, input.id],
      );
      return token;
    },
    clearChildToken(transaction, input) {
      const row = transaction.get(
        "SELECT child_token FROM git_operation WHERE id = ?",
        [input.id],
      ) as { child_token: string | null } | undefined;
      const token = row?.child_token ?? null;
      transaction.run(
        "UPDATE git_operation SET child_token = NULL WHERE id = ?",
        [input.id],
      );
      return token;
    },
  };
}

function readOpenChildToken(
  transaction: Transaction,
  id: string,
): string | null {
  const row = transaction.get(
    "SELECT child_token FROM git_operation WHERE id = ? AND state = 'open'",
    [id],
  ) as { child_token: string | null } | undefined;
  if (row === undefined) {
    throw new JournalError(
      "journal-row-not-open",
      `git operation ${id} is not open`,
    );
  }
  return row.child_token;
}

function mapInFlightRow(row: unknown): InFlightJournalRow {
  const value = row as Record<string, unknown>;
  return {
    id: value.id as string,
    repositoryId: value.repository_id as string,
    repositoryHomePath: value.home_path as string,
    intent: value.intent as GitIntent,
    ref: value.ref as string,
    baseOid: value.base_oid as string,
    proposedHeadOid: value.proposed_head_oid as string,
    childToken: value.child_token as string,
  };
}

function mapOpenRow(row: unknown): OpenJournalRow {
  const value = row as Record<string, unknown>;
  return {
    id: value.id as string,
    repositoryId: value.repository_id as string,
    repositoryHomePath: value.home_path as string,
    intent: value.intent as GitIntent,
    ref: value.ref as string,
    baseOid: value.base_oid as string,
    proposedHeadOid: value.proposed_head_oid as string,
    childToken: value.child_token as string | null,
  };
}
