import { basename } from "node:path";

import {
  GITOP_PID_PATTERN,
  SEED_PID_PATTERN,
  RecoveryError,
  type ReapReport,
  type ReapedChild,
  type RecoveryFinding,
} from "../../domain/recovery.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Git, GitJournal } from "../../services/git/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

export type ReapOrphansDependencies = Readonly<{
  storage: Storage;
  journal: GitJournal;
  git: Git;
  events: EventLog;
  clock: Clock;
  runDirectory: string;
  graceMs: number;
}>;

export type ReapOrphansInput = Readonly<{ actor: string }>;

type ReapCandidate = Readonly<{
  pidFile: string;
  gitOperationId: string | null;
  repositoryId: string | null;
}>;

export async function reapOrphans(
  dependencies: ReapOrphansDependencies,
  input: ReapOrphansInput,
): Promise<ReapReport> {
  const rows = dependencies.storage.transact((transaction) =>
    dependencies.journal.listInFlight(transaction).map((row) => ({
      pidFile: row.childToken,
      gitOperationId: row.id,
      repositoryId: row.repositoryId,
    })),
  );
  const claimed = new Set(rows.map((candidate) => candidate.pidFile));
  const listed = await dependencies.git.listPidFiles({
    runDirectory: dependencies.runDirectory,
  });
  const files = listed
    .filter((pidFile) => !claimed.has(pidFile))
    .map(attributePidFile);

  const children: ReapedChild[] = [];
  const findings: RecoveryFinding[] = [];

  for (const candidate of [...rows, ...files]) {
    const inspection = await dependencies.git.inspectChild({
      pidFile: candidate.pidFile,
    });
    switch (inspection.finding) {
      case "no-pid-file":
        children.push(
          await settle(dependencies, input.actor, candidate, "no-pid-file"),
        );
        break;
      case "pid-file-unreadable": {
        const child = await settle(
          dependencies,
          input.actor,
          candidate,
          "pid-file-unreadable",
        );
        children.push(child);
        findings.push({
          step: "reap",
          code: "pid-file-unreadable",
          repositoryId: child.repositoryId,
          detail: inspection.detail,
        });
        break;
      }
      case "process-absent":
        children.push(
          await settle(dependencies, input.actor, candidate, "process-absent"),
        );
        break;
      case "started-later": {
        const child = await settle(
          dependencies,
          input.actor,
          candidate,
          "started-later",
        );
        children.push(child);
        findings.push({
          step: "reap",
          code: "pid-reused",
          repositoryId: child.repositoryId,
          detail: `pid ${inspection.pid} started at ${inspection.startedAt} after its pid file was written at ${inspection.recordedAt}`,
        });
        break;
      }
      case "liveness-unknown":
        throw new RecoveryError(
          "liveness-unknown",
          `the liveness of git process ${inspection.pid} for repository ${candidate.repositoryId ?? "unknown"} could not be established: ${inspection.detail}; pid file ${candidate.pidFile}`,
        );
      case "alive": {
        const stopped = await dependencies.git.stopChild({
          pid: inspection.pid,
          graceMs: dependencies.graceMs,
        });
        if (!stopped) {
          throw new RecoveryError(
            "orphan-alive",
            `git process ${inspection.pid} for repository ${candidate.repositoryId ?? "unknown"} did not exit; pid file ${candidate.pidFile}`,
          );
        }
        children.push(
          await settle(dependencies, input.actor, candidate, "stopped"),
        );
        break;
      }
    }
  }

  return { children, findings };
}

function attributePidFile(pidFile: string): ReapCandidate {
  const name = basename(pidFile);
  const seed = SEED_PID_PATTERN.exec(name);
  if (seed !== null) {
    return { pidFile, gitOperationId: null, repositoryId: seed[1] ?? null };
  }
  const gitop = GITOP_PID_PATTERN.exec(name);
  if (gitop !== null) {
    return { pidFile, gitOperationId: gitop[1] ?? null, repositoryId: null };
  }
  return { pidFile, gitOperationId: null, repositoryId: null };
}

async function settle(
  dependencies: ReapOrphansDependencies,
  actor: string,
  candidate: ReapCandidate,
  finding: ReapedChild["finding"],
): Promise<ReapedChild> {
  let repositoryId = candidate.repositoryId;
  const operationId = candidate.gitOperationId;
  if (operationId !== null) {
    dependencies.storage.transact((transaction) => {
      let resolved = repositoryId;
      if (resolved === null) {
        const row = transaction.get(
          "SELECT repository_id FROM git_operation WHERE id = ?",
          [operationId],
        ) as { repository_id: string } | undefined;
        resolved = row?.repository_id ?? null;
      }
      repositoryId = resolved;
      dependencies.journal.clearChildToken(transaction, { id: operationId });
      if (resolved !== null) {
        appendReapEvent(
          dependencies,
          transaction,
          actor,
          resolved,
          candidate,
          finding,
        );
      }
    });
  } else if (repositoryId !== null) {
    const subjectId = repositoryId;
    dependencies.storage.transact((transaction) => {
      appendReapEvent(
        dependencies,
        transaction,
        actor,
        subjectId,
        candidate,
        finding,
      );
    });
  }
  await dependencies.git.removePidFile({ pidFile: candidate.pidFile });
  return {
    pidFile: candidate.pidFile,
    gitOperationId: candidate.gitOperationId,
    repositoryId,
    finding,
  };
}

function appendReapEvent(
  dependencies: ReapOrphansDependencies,
  transaction: Transaction,
  actor: string,
  repositoryId: string,
  candidate: ReapCandidate,
  finding: ReapedChild["finding"],
): void {
  dependencies.events.append(transaction, {
    subjectKind: "repository",
    subjectId: repositoryId,
    type: "recovery.childReaped",
    actorKind: "daemon",
    actorId: actor,
    payload: {
      gitOperationId: candidate.gitOperationId,
      pidFile: candidate.pidFile,
      finding,
    },
  });
}
