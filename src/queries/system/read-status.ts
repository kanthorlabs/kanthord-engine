import type { Clock } from "../../services/clock/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { DependencyLine, HealthResult } from "../../domain/health.ts";

export type ReadStatusDependencies = Readonly<{
  storage: Storage;
  clock: Clock;
  health: () => HealthResult;
  version: string;
  bind: string;
  startedAt: string;
}>;

export type NodeCountLine = Readonly<{
  kind: string;
  state: string;
  blockReason: string | null;
  count: number;
}>;

export type ReconcileLine = Readonly<{
  id: string;
  name: string;
  divergedLandingOid: string;
  divergedUpstreamOid: string;
}>;

export type ExpiredLeaseLine = Readonly<{
  subjectKind: "node" | "repository";
  subjectId: string;
  owner: string | null;
  fence: number;
  expiresAt: number;
}>;

export type ReadStatusResult = Readonly<{
  version: string;
  bind: string;
  startedAt: string;
  status: "ok" | "degraded";
  dependencies: readonly DependencyLine[];
  nodes: readonly NodeCountLine[];
  repositories: readonly ReconcileLine[];
  leases: readonly ExpiredLeaseLine[];
}>;

export function readStatus(
  dependencies: ReadStatusDependencies,
): ReadStatusResult {
  const health = dependencies.health();
  const nodes: NodeCountLine[] = [];
  const repositories: ReconcileLine[] = [];
  const leases: ExpiredLeaseLine[] = [];
  dependencies.storage.transact((transaction) => {
    for (const row of transaction.all(
      `SELECT kind AS kind, state AS state, block_reason AS blockReason, COUNT(*) AS count
FROM node
GROUP BY kind, state, block_reason
ORDER BY kind ASC, state ASC, block_reason ASC`,
    )) {
      nodes.push(row as NodeCountLine);
    }
    for (const row of transaction.all(
      `SELECT id AS id, name AS name,
       diverged_landing_oid AS divergedLandingOid,
       diverged_upstream_oid AS divergedUpstreamOid
FROM repository
WHERE state = 'needs-reconcile'
ORDER BY id ASC`,
    )) {
      repositories.push(row as ReconcileLine);
    }
    for (const row of transaction.all(
      `SELECT subject_kind AS subjectKind, subject_id AS subjectId,
       owner AS owner, fence AS fence, expires_at AS expiresAt
FROM lease
WHERE expires_at IS NOT NULL AND expires_at <= ?
ORDER BY subject_kind ASC, subject_id ASC`,
      [dependencies.clock.now()],
    )) {
      leases.push(row as ExpiredLeaseLine);
    }
  });
  return {
    version: dependencies.version,
    bind: dependencies.bind,
    startedAt: dependencies.startedAt,
    status: health.status,
    dependencies: health.dependencies,
    nodes,
    repositories,
    leases,
  };
}
