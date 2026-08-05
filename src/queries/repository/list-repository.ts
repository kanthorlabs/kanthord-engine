import type { Git } from "../../services/git/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { RepositoryView } from "../../domain/repository.ts";

export type ListRepositoryDependencies = Readonly<{
  storage: Storage;
  git: Git;
}>;

export type RepositoryRow = Readonly<{
  id: string;
  name: string;
  remote_url: string;
  credential_id: string;
  credential_name: string;
  home_path: string;
  upstream_branch: string;
  landing_branch: string;
  publish_ref: string;
  publish_on_approval: number;
  state: "ready" | "needs-reconcile";
  diverged_landing_oid: string | null;
  diverged_upstream_oid: string | null;
  fetched_upstream_oid: string | null;
  updated_at: number;
}>;

const COLUMNS = `r.id, r.name, r.remote_url, r.credential_id, p.name AS credential_name,
       r.home_path, r.upstream_branch, r.landing_branch, r.publish_ref,
       r.publish_on_approval, r.state, r.diverged_landing_oid,
       r.diverged_upstream_oid, r.fetched_upstream_oid, r.updated_at`;

const LIST_REPOSITORIES_SQL = `SELECT ${COLUMNS}
FROM repository r JOIN provider p ON p.id = r.credential_id
ORDER BY r.id ASC`;

const LIST_REPOSITORIES_BY_STATE_SQL = `SELECT ${COLUMNS}
FROM repository r JOIN provider p ON p.id = r.credential_id
WHERE r.state = ?
ORDER BY r.id ASC`;

async function toRepositoryView(
  dependencies: ListRepositoryDependencies,
  row: RepositoryRow,
): Promise<RepositoryView> {
  const landingRef = `refs/heads/${row.landing_branch}`;
  const trackingRef = `refs/remotes/origin/${row.upstream_branch}`;
  const landingOid = await dependencies.git.resolveRef({
    gitDir: row.home_path,
    ref: landingRef,
  });
  const trackingOid = await dependencies.git.resolveRef({
    gitDir: row.home_path,
    ref: trackingRef,
  });
  return {
    id: row.id,
    name: row.name,
    remoteUrl: row.remote_url,
    credential: { id: row.credential_id, name: row.credential_name },
    upstreamBranch: row.upstream_branch,
    landingBranch: row.landing_branch,
    landingRef,
    trackingRef,
    publishRef: row.publish_ref,
    publishOnApproval: row.publish_on_approval === 1,
    state: row.state,
    landingOid,
    trackingOid,
    fetchedUpstreamOid: row.fetched_upstream_oid,
    divergedLandingOid: row.diverged_landing_oid,
    divergedUpstreamOid: row.diverged_upstream_oid,
    updatedAt: row.updated_at,
  };
}

export async function listRepositories(
  dependencies: ListRepositoryDependencies,
  input: Readonly<{ state?: "ready" | "needs-reconcile" }>,
): Promise<readonly RepositoryView[]> {
  const filtered = input.state !== undefined;
  const rows: readonly unknown[] = dependencies.storage.transact(
    (transaction) =>
      filtered
        ? transaction.all(LIST_REPOSITORIES_BY_STATE_SQL, [input.state])
        : transaction.all(LIST_REPOSITORIES_SQL),
  );
  const views: RepositoryView[] = [];
  for (const row of rows) {
    views.push(await toRepositoryView(dependencies, row as RepositoryRow));
  }
  return views;
}
