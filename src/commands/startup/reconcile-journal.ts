import {
  RecoveryError,
  ZERO_OID,
  type RecoveryFinding,
} from "../../domain/recovery.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import {
  GitError,
  type Git,
  type GitJournal,
  type OpenJournalRow,
} from "../../services/git/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

export type ReconcileJournalDependencies = Readonly<{
  storage: Storage;
  journal: GitJournal;
  git: Git;
  events: EventLog;
  clock: Clock;
}>;

export type ReconcileJournalInput = Readonly<{ actor: string }>;

export type ReconcileJournalResult = Readonly<{
  completed: number;
  discarded: number;
  leftOpen: number;
  refusesNewWork: readonly string[];
  findings: readonly RecoveryFinding[];
}>;

type ReconciledVerdict = "complete" | "discarded" | "absent" | "unexpected";

export async function reconcileJournal(
  dependencies: ReconcileJournalDependencies,
  input: ReconcileJournalInput,
): Promise<ReconcileJournalResult> {
  const rows = dependencies.storage.transact((transaction) =>
    dependencies.journal.listOpen(transaction),
  );
  const now = dependencies.clock.now();

  let completed = 0;
  let discarded = 0;
  let leftOpen = 0;
  const refusesNewWork: string[] = [];
  const findings: RecoveryFinding[] = [];

  for (const row of rows) {
    if (row.intent === "publish") {
      const token = dependencies.storage.transact((transaction) => {
        const cleared = dependencies.journal.markPublishPending(transaction, {
          id: row.id,
          outcome: "awaiting-remote-reconcile",
        });
        dependencies.events.append(transaction, {
          subjectKind: "repository",
          subjectId: row.repositoryId,
          type: "recovery.publishReconcilePending",
          actorKind: "daemon",
          actorId: input.actor,
          payload: {
            gitOperationId: row.id,
            ref: row.ref,
            proposedHeadOid: row.proposedHeadOid,
          },
        });
        return cleared;
      });
      await removeClearedToken(dependencies, token);
      leftOpen++;
      refusesNewWork.push(row.repositoryId);
      continue;
    }

    let observed: string | null;
    try {
      observed = await dependencies.git.resolveRef({
        gitDir: row.repositoryHomePath,
        ref: row.ref,
      });
    } catch (error) {
      if (error instanceof GitError) {
        throw new RecoveryError(
          "ref-unreadable",
          `the ref ${row.ref} of repository ${row.repositoryId} could not be read`,
        );
      }
      throw error;
    }

    if (observed === row.proposedHeadOid) {
      const token = settle(
        dependencies,
        input.actor,
        row,
        now,
        "complete",
        observed,
      );
      await removeClearedToken(dependencies, token);
      completed++;
      continue;
    }

    if (observed === row.baseOid) {
      const token = settle(
        dependencies,
        input.actor,
        row,
        now,
        "discarded",
        observed,
      );
      await removeClearedToken(dependencies, token);
      discarded++;
      continue;
    }

    if (observed === null) {
      const token = settle(
        dependencies,
        input.actor,
        row,
        now,
        "absent",
        observed,
      );
      await removeClearedToken(dependencies, token);
      if (row.baseOid !== ZERO_OID) {
        findings.push({
          step: "reconcile",
          code: "ref-absent-with-base",
          repositoryId: row.repositoryId,
          detail: `the ref ${row.ref} of repository ${row.repositoryId} is absent but the base ${row.baseOid} was recorded`,
        });
      }
      discarded++;
      continue;
    }

    const token = settle(
      dependencies,
      input.actor,
      row,
      now,
      "unexpected",
      observed,
    );
    await removeClearedToken(dependencies, token);
    findings.push({
      step: "reconcile",
      code: "ref-unexpected",
      repositoryId: row.repositoryId,
      detail: `the ref ${row.ref} of repository ${row.repositoryId} reads ${observed}, matching neither the base nor the proposed head`,
    });
    leftOpen++;
    refusesNewWork.push(row.repositoryId);
  }

  const sortedRefusals = [...new Set(refusesNewWork)].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );

  return {
    completed,
    discarded,
    leftOpen,
    refusesNewWork: sortedRefusals,
    findings,
  };
}

function settle(
  dependencies: ReconcileJournalDependencies,
  actor: string,
  row: OpenJournalRow,
  now: number,
  verdict: ReconciledVerdict,
  observed: string | null,
): string | null {
  return dependencies.storage.transact((transaction) => {
    let cleared: string | null;
    switch (verdict) {
      case "complete":
        cleared = dependencies.journal.complete(transaction, {
          id: row.id,
          resultHeadOid: observed,
          outcome: "recovered-complete",
          completedAt: now,
        });
        break;
      case "discarded":
        cleared = dependencies.journal.discard(transaction, {
          id: row.id,
          outcome: "recovered-discarded",
          completedAt: now,
        });
        break;
      case "absent":
        cleared = dependencies.journal.discard(transaction, {
          id: row.id,
          outcome: "recovered-absent",
          completedAt: now,
        });
        break;
      case "unexpected":
        cleared = dependencies.journal.clearChildToken(transaction, {
          id: row.id,
        });
        break;
    }
    dependencies.events.append(transaction, {
      subjectKind: "repository",
      subjectId: row.repositoryId,
      type: "recovery.journalReconciled",
      actorKind: "daemon",
      actorId: actor,
      payload: {
        gitOperationId: row.id,
        intent: row.intent,
        ref: row.ref,
        observed,
        verdict,
      },
    });
    return cleared;
  });
}

async function removeClearedToken(
  dependencies: ReconcileJournalDependencies,
  token: string | null,
): Promise<void> {
  if (token !== null) {
    await dependencies.git.removePidFile({ pidFile: token });
  }
}
