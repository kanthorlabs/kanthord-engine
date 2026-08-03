import type { Migration } from "./migration.ts";

export const graphAndPlan: Migration = {
  version: 2,
  name: "0002-graph-and-plan",
  statements: [
    `CREATE TABLE plan_revision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  parent_id TEXT REFERENCES plan_revision(id),
  import_id TEXT NOT NULL,
  submitted_blob TEXT NOT NULL REFERENCES blob(hash),
  choices_blob TEXT NOT NULL REFERENCES blob(hash),
  accepted_blob TEXT NOT NULL REFERENCES blob(hash),
  UNIQUE (project_id, import_id)
) STRICT`,
    `CREATE TABLE node (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  kind TEXT NOT NULL CHECK (kind IN ('initiative', 'objective', 'task')),
  parent_id TEXT REFERENCES node(id),
  title TEXT NOT NULL,
  instruction_blob TEXT NOT NULL REFERENCES blob(hash),
  acceptance_blob TEXT REFERENCES blob(hash),
  worker TEXT,
  repository_id TEXT REFERENCES repository(id),
  state TEXT NOT NULL,
  block_reason TEXT,
  discard_reason TEXT,
  revision TEXT NOT NULL REFERENCES plan_revision(id),
  updated_at INTEGER NOT NULL,
  CHECK ((kind = 'initiative') = (parent_id IS NULL)),
  CHECK ((kind = 'objective') = (repository_id IS NOT NULL)),
  CHECK ((kind = 'task') = (acceptance_blob IS NOT NULL)),
  CHECK (state IN ('pending', 'ready', 'running', 'blocked',
                   'awaiting_approval', 'done', 'partial', 'discarded')),
  CHECK ((state = 'blocked') = (block_reason IS NOT NULL)),
  CHECK (block_reason IS NULL OR block_reason IN ('attempt-limit', 'dependency-discarded',
                   'stale-base', 'dirty-recovery', 'e2e-failed', 'abandoned')),
  CHECK (state <> 'awaiting_approval' OR kind = 'objective'),
  CHECK (state <> 'partial' OR kind <> 'task')
) STRICT`,
    `CREATE TABLE edge (
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL REFERENCES node(id),
  to_node TEXT NOT NULL REFERENCES node(id),
  waived_at INTEGER,
  UNIQUE (from_node, to_node),
  CHECK (from_node <> to_node)
) STRICT`,
  ],
};
