import type { Migration } from "./migration.ts";

export const coreEntities: Migration = {
  version: 1,
  name: "0001-core-entities",
  statements: [
    `CREATE TABLE blob (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  content BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT`,
    `CREATE TABLE provider (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('llm', 'git')),
  set_default_at INTEGER,
  payload_ciphertext BLOB NOT NULL,
  payload_iv BLOB NOT NULL,
  payload_tag BLOB NOT NULL,
  key_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(payload_iv) = 12),
  CHECK (length(payload_tag) = 16)
) STRICT`,
    `CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  worker TEXT,
  e2e_json TEXT,
  updated_at INTEGER NOT NULL
) STRICT`,
    `CREATE TABLE project_binding (
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('git', 'provider')),
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, kind, target_id)
) STRICT`,
    `CREATE TABLE repository (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  remote_url TEXT NOT NULL,
  credential_id TEXT NOT NULL REFERENCES provider(id),
  home_path TEXT NOT NULL,
  upstream_branch TEXT NOT NULL,
  landing_branch TEXT NOT NULL,
  publish_ref TEXT NOT NULL,
  publish_on_approval INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK (state IN ('ready', 'needs-reconcile')),
  diverged_landing_oid TEXT,
  diverged_upstream_oid TEXT,
  fetched_upstream_oid TEXT,
  updated_at INTEGER NOT NULL,
  CHECK (
    (state = 'needs-reconcile')
    = (diverged_landing_oid IS NOT NULL AND diverged_upstream_oid IS NOT NULL)
  )
) STRICT`,
    `CREATE TABLE profile (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL UNIQUE REFERENCES repository(id),
  content_blob TEXT NOT NULL REFERENCES blob(hash),
  updated_at INTEGER NOT NULL
) STRICT`,
  ],
};
