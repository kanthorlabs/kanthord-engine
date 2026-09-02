import type { Migration } from "./migration.ts";

export const migration0012RunModel: Migration = {
  version: 12,
  name: "0012-run-model",
  rebuild: true,
  statements: [
    "DELETE FROM check_result",
    "DELETE FROM candidate",
    "DELETE FROM attempt",
    "DELETE FROM run",
    "UPDATE git_operation SET run_id = NULL WHERE run_id IS NOT NULL",
    "ALTER TABLE run RENAME TO run_old",
    "DROP INDEX run_one_active",
    `CREATE TABLE run (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('structural', 'execution', 'review')),
  node_id         TEXT NOT NULL REFERENCES node(id),
  driver          TEXT NOT NULL CHECK (driver IN ('internal', 'external')),
  workspace_id    TEXT REFERENCES workspace(id),
  worker          TEXT NOT NULL,
  fence           INTEGER NOT NULL,
  attempt_limit   INTEGER NOT NULL,
  head_oid        TEXT,
  judged_oid      TEXT,
  graph_revision  TEXT REFERENCES plan_revision(id),
  agents_json     TEXT NOT NULL CHECK (json_valid(agents_json)),
  expires_at      INTEGER NOT NULL,
  max_lifetime_at INTEGER NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('active', 'ended')),
  outcome         TEXT,
  ended_at        INTEGER,
  UNIQUE (id, driver)
) STRICT`,
    "CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active'",
    `CREATE TABLE run_base (
  run_id        TEXT NOT NULL REFERENCES run(id),
  repository_id TEXT NOT NULL REFERENCES repository(id),
  oid           TEXT NOT NULL,
  PRIMARY KEY (run_id, repository_id)
) STRICT`,
    "DROP TABLE run_old",
  ],
};
