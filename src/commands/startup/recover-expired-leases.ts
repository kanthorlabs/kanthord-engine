import { join } from "node:path";

import type { RecoveryFinding } from "../../domain/recovery.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import { GitError, type Git } from "../../services/git/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Storage } from "../../services/storage/index.ts";

export type RecoverExpiredLeasesDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  git: Git;
  events: EventLog;
  clock: Clock;
}>;

export type RecoverExpiredLeasesInput = Readonly<{ actor: string }>;

export type RecoverExpiredLeasesResult = Readonly<{
  returnedToReady: number;
  blocked: number;
  findings: readonly RecoveryFinding[];
}>;

type CandidateRow = Readonly<{
  subject_id: string;
  fence: number;
  kind: string;
  base_oid: string | null;
  path: string | null;
  repository_id: string | null;
  revision: string;
}>;

const CANDIDATE_SQL = `
SELECT l.subject_id, l.fence, n.kind, r.base_oid, w.path, w.repository_id, n.revision AS revision
FROM lease l
JOIN node n ON n.id = l.subject_id
LEFT JOIN run r ON r.node_id = n.id AND r.state = 'active'
LEFT JOIN workspace w ON w.id = r.workspace_id
WHERE l.subject_kind = 'node'
  AND l.expires_at IS NOT NULL
  AND l.expires_at <= ?
  AND n.state = 'running'
ORDER BY l.subject_id
`;

export async function recoverExpiredLeases(
  dependencies: RecoverExpiredLeasesDependencies,
  input: RecoverExpiredLeasesInput,
): Promise<RecoverExpiredLeasesResult> {
  const now = dependencies.clock.now();
  const rows = dependencies.storage.transact((transaction) =>
    transaction.all(CANDIDATE_SQL, [now]),
  ) as readonly CandidateRow[];

  let returnedToReady = 0;
  let blocked = 0;
  const findings: RecoveryFinding[] = [];

  for (const row of rows) {
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

  return { returnedToReady, blocked, findings };
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
      "UPDATE lease SET owner = NULL, expires_at = NULL, renewed_at = NULL, fence = fence + 1 WHERE subject_kind = 'node' AND subject_id = ?",
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
        fence: row.fence + 1,
      },
    });
  });
}
