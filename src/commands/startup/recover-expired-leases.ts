import { join } from "node:path";

import type { RecoveryFinding } from "../../domain/recovery.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Execution } from "../../services/execution/index.ts";
import { GitError, type Git } from "../../services/git/index.ts";
import type { Lease } from "../../services/lease/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { Transaction } from "../../services/storage/index.ts";

export type RecoverExpiredLeasesDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  git: Git;
  events: EventLog;
  clock: Clock;
  lease: Lease;
  execution: Execution;
}>;

export type RecoverExpiredLeasesInput = Readonly<{ actor: string }>;

export type RecoverExpiredLeasesResult = Readonly<{
  returnedToReady: number;
  objectivesFreed: number;
  blocked: number;
  findings: readonly RecoveryFinding[];
}>;

type CandidateRow = Readonly<{
  subject_id: string;
  fence: number;
  kind: string;
  base_oid: string | null;
  run_id: string | null;
  driver: string | null;
  path: string | null;
  repository_id: string | null;
  revision: string;
}>;

const CANDIDATE_SQL = `
SELECT l.subject_id, l.fence, n.kind,
       ra.base_oid, ra.id AS run_id, COALESCE(ra.driver, rl.driver) AS driver,
       w.path, w.repository_id, n.revision AS revision
FROM lease l
JOIN node n ON n.id = l.subject_id
LEFT JOIN run ra ON ra.node_id = n.id AND ra.state = 'active'
LEFT JOIN run rl ON rl.id = (
  SELECT id FROM run WHERE node_id = n.id ORDER BY id DESC LIMIT 1
)
LEFT JOIN workspace w ON w.id = ra.workspace_id
WHERE l.subject_kind = 'node'
  AND l.expires_at IS NOT NULL
  AND l.expires_at <= ?
  AND n.state = 'running'
ORDER BY l.subject_id
`;

export type SweepExpiredExternalLeasesDependencies = Readonly<{
  plan: PlanStore;
  lease: Lease;
  execution: Execution;
  events: EventLog;
}>;

export type SweepExpiredExternalLeasesInput = Readonly<{
  actor: string;
  now: number;
}>;

export type SweepExpiredExternalLeasesResult = Readonly<{
  returnedToReady: number;
  objectivesFreed: number;
}>;

export function sweepExpiredExternalLeases(
  dependencies: SweepExpiredExternalLeasesDependencies,
  transaction: Transaction,
  input: SweepExpiredExternalLeasesInput,
): SweepExpiredExternalLeasesResult {
  const rows = transaction.all(CANDIDATE_SQL, [
    input.now,
  ]) as readonly CandidateRow[];
  const sweptTasks = new Set(
    rows.filter((row) => row.kind === "task").map((row) => row.subject_id),
  );
  let returnedToReady = 0;
  let objectivesFreed = 0;
  for (const row of rows) {
    if (row.driver !== "external") {
      continue;
    }
    if (row.kind !== "task") {
      endActiveTaskRunsUnderObjective(dependencies, transaction, {
        objectiveId: row.subject_id,
        skipTaskIds: sweptTasks,
        outcome: "expired",
        at: input.now,
      });
    }
    if (row.run_id !== null) {
      for (const attempt of dependencies.execution.attemptsOfRun(
        transaction,
        row.run_id,
      )) {
        if (attempt.outcome !== null) {
          continue;
        }
        dependencies.execution.closeAttempt(transaction, {
          attemptId: attempt.id,
          outcome: "cancelled",
          at: input.now,
        });
      }
      dependencies.execution.endRun(transaction, {
        runId: row.run_id,
        outcome: "expired",
        at: input.now,
      });
    }
    transaction.run(
      "UPDATE lease SET owner = NULL, owner_kind = NULL, acquired_at = NULL, renewed_at = NULL, expires_at = NULL WHERE subject_kind = 'node' AND subject_id = ?",
      [row.subject_id],
    );
    if (row.kind === "task") {
      dependencies.plan.setNodeState(transaction, {
        id: row.subject_id,
        from: "running",
        to: "ready",
        trigger: "claim-expired",
        blockReason: null,
        at: input.now,
        cause: { revision: row.revision, importId: null },
      });
      returnedToReady++;
    } else {
      objectivesFreed++;
    }
    dependencies.events.append(transaction, {
      subjectKind: "node",
      subjectId: row.subject_id,
      type: "recovery.leaseRecovered",
      actorKind: "daemon",
      actorId: input.actor,
      payload: {
        target: row.kind === "task" ? "ready" : "running",
        clean: false,
        headOid: null,
        baseOid: row.base_oid,
        fence: row.fence,
        driver: "external",
        runId: row.run_id,
      },
    });
  }
  return { returnedToReady, objectivesFreed };
}

function endActiveTaskRunsUnderObjective(
  dependencies: SweepExpiredExternalLeasesDependencies,
  transaction: Transaction,
  input: Readonly<{
    objectiveId: string;
    skipTaskIds: ReadonlySet<string>;
    outcome: string;
    at: number;
  }>,
): void {
  const children = dependencies.plan
    .readAllNodes(transaction)
    .filter(
      (candidate) =>
        candidate.parentId === input.objectiveId &&
        !input.skipTaskIds.has(candidate.id),
    )
    .sort((left, right) => compareIds(left.id, right.id));
  for (const child of children) {
    const childRun = dependencies.execution.activeRunOfNode(
      transaction,
      child.id,
    );
    if (childRun === null) {
      continue;
    }
    for (const attempt of dependencies.execution.attemptsOfRun(
      transaction,
      childRun.id,
    )) {
      if (attempt.outcome !== null) {
        continue;
      }
      dependencies.execution.closeAttempt(transaction, {
        attemptId: attempt.id,
        outcome: "cancelled",
        at: input.at,
      });
    }
    dependencies.execution.endRun(transaction, {
      runId: childRun.id,
      outcome: input.outcome,
      at: input.at,
    });
  }
}

function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export async function recoverExpiredLeases(
  dependencies: RecoverExpiredLeasesDependencies,
  input: RecoverExpiredLeasesInput,
): Promise<RecoverExpiredLeasesResult> {
  const now = dependencies.clock.now();
  const rows = dependencies.storage.transact((transaction) =>
    transaction.all(CANDIDATE_SQL, [now]),
  ) as readonly CandidateRow[];

  let returnedToReady = 0;
  let objectivesFreed = 0;
  let blocked = 0;
  const findings: RecoveryFinding[] = [];

  const externalRows = rows.filter((row) => row.driver === "external");
  const internalRows = rows.filter((row) => row.driver !== "external");

  if (externalRows.length > 0) {
    const swept = dependencies.storage.transact((transaction) =>
      sweepExpiredExternalLeases(
        {
          plan: dependencies.plan,
          lease: dependencies.lease,
          execution: dependencies.execution,
          events: dependencies.events,
        },
        transaction,
        { actor: input.actor, now },
      ),
    );
    returnedToReady += swept.returnedToReady;
    objectivesFreed += swept.objectivesFreed;
  }

  for (const row of internalRows) {
    if (row.kind !== "task") {
      findings.push({
        step: "leases",
        code: "lease-expired-on-non-task",
        repositoryId: null,
        detail: `the expired lease of node ${row.subject_id} cannot be recovered because the node is not a task`,
      });
      continue;
    }

    if (row.path === null || row.base_oid === null) {
      writeVerdict(dependencies, input.actor, row, now, {
        target: "blocked",
        clean: false,
        head: null,
      });
      blocked++;
      findings.push({
        step: "leases",
        code: "recovery-inputs-missing",
        repositoryId: row.repository_id,
        detail: `the task ${row.subject_id} has no active run with a workspace and a recorded base oid`,
      });
      continue;
    }

    let clean: boolean;
    let head: string | null;
    try {
      clean = await dependencies.git.worktreeClean({ workDir: row.path });
      head = await dependencies.git.resolveRef({
        gitDir: join(row.path, ".git"),
        ref: "HEAD",
      });
    } catch (error) {
      if (error instanceof GitError) {
        writeVerdict(dependencies, input.actor, row, now, {
          target: "blocked",
          clean: false,
          head: null,
        });
        blocked++;
        findings.push({
          step: "leases",
          code: "workspace-unreadable",
          repositoryId: row.repository_id,
          detail: `the workspace ${row.path} of task ${row.subject_id} could not be read: ${error.message}`,
        });
        continue;
      }
      throw error;
    }

    const target = clean && head === row.base_oid ? "ready" : "blocked";
    writeVerdict(dependencies, input.actor, row, now, {
      target,
      clean,
      head,
    });
    if (target === "ready") {
      returnedToReady++;
    } else {
      blocked++;
    }
  }

  return { returnedToReady, objectivesFreed, blocked, findings };
}

function writeVerdict(
  dependencies: RecoverExpiredLeasesDependencies,
  actor: string,
  row: CandidateRow,
  now: number,
  verdict: Readonly<{
    target: "ready" | "blocked";
    clean: boolean;
    head: string | null;
  }>,
): void {
  dependencies.storage.transact((transaction) => {
    dependencies.plan.setNodeState(transaction, {
      id: row.subject_id,
      from: "running",
      to: verdict.target,
      trigger:
        verdict.target === "ready" ? "recovery-requeued" : "recovery-blocked",
      blockReason: verdict.target === "ready" ? null : "dirty-recovery",
      at: now,
      cause: { revision: row.revision, importId: null },
    });
    transaction.run(
      "UPDATE lease SET owner = NULL, owner_kind = NULL, acquired_at = NULL, renewed_at = NULL, expires_at = NULL WHERE subject_kind = 'node' AND subject_id = ?",
      [row.subject_id],
    );
    dependencies.events.append(transaction, {
      subjectKind: "node",
      subjectId: row.subject_id,
      type:
        verdict.target === "ready"
          ? "recovery.leaseRecovered"
          : "recovery.leaseBlocked",
      actorKind: "daemon",
      actorId: actor,
      payload: {
        target: verdict.target,
        clean: verdict.clean,
        headOid: verdict.head,
        baseOid: row.base_oid,
        fence: row.fence,
      },
    });
  });
}
