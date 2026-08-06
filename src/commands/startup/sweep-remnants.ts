import type { ReapReport, RecoveryFinding } from "../../domain/recovery.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Git } from "../../services/git/index.ts";
import type { Storage } from "../../services/storage/index.ts";

export type SweepRemnantsDependencies = Readonly<{
  storage: Storage;
  git: Git;
  events: EventLog;
  keyDirectory: string;
}>;

export type SweepRemnantsInput = Readonly<{
  actor: string;
  reap: ReapReport;
}>;

export type SweepRemnantsResult = Readonly<{
  removed: number;
  findings: readonly RecoveryFinding[];
}>;

type SweepBoundaryShape = Readonly<{
  kind: "bare-home" | "workspace";
  root: string;
  repositoryId: string;
}>;

export async function sweepRemnants(
  dependencies: SweepRemnantsDependencies,
  input: SweepRemnantsInput,
): Promise<SweepRemnantsResult> {
  const boundaries = dependencies.storage.transact((transaction) => {
    const result: SweepBoundaryShape[] = [];
    const repositoryRows = transaction.all(
      "SELECT id, home_path FROM repository ORDER BY id",
    ) as ReadonlyArray<Readonly<{ id: string; home_path: string }>>;
    for (const row of repositoryRows) {
      result.push({
        kind: "bare-home",
        root: row.home_path,
        repositoryId: row.id,
      });
    }
    const workspaceRows = transaction.all(
      "SELECT w.path, w.repository_id FROM workspace w ORDER BY w.id",
    ) as ReadonlyArray<Readonly<{ path: string; repository_id: string }>>;
    for (const row of workspaceRows) {
      result.push({
        kind: "workspace",
        root: row.path,
        repositoryId: row.repository_id,
      });
    }
    return result;
  });

  const report = await dependencies.git.sweepHome({
    boundaries,
    keyDirectory: dependencies.keyDirectory,
  });

  dependencies.storage.transact((transaction) => {
    for (const removal of report.removed) {
      if (removal.repositoryId !== null) {
        dependencies.events.append(transaction, {
          subjectKind: "repository",
          subjectId: removal.repositoryId,
          type: "recovery.remnantRemoved",
          actorKind: "daemon",
          actorId: input.actor,
          payload: { path: removal.path, class: removal.class },
        });
      }
    }
    for (const refusal of report.refused) {
      if (refusal.repositoryId !== null) {
        dependencies.events.append(transaction, {
          subjectKind: "repository",
          subjectId: refusal.repositoryId,
          type: "recovery.remnantRefused",
          actorKind: "daemon",
          actorId: input.actor,
          payload: {
            path: refusal.path,
            class: refusal.class,
            reason: refusal.reason,
          },
        });
      }
    }
  });

  const findings = report.refused.map((refusal) => ({
    step: "sweep" as const,
    code: refusal.reason,
    repositoryId: refusal.repositoryId,
    detail: `${refusal.class} ${refusal.path}`,
  }));

  return { removed: report.removed.length, findings };
}
