import type { Migration } from "./migration.ts";

export const actorTableDdl = `CREATE TABLE actor (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'harness')),
  name TEXT NOT NULL UNIQUE,
  token_sha256 BLOB,
  registered_by TEXT REFERENCES actor(id),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT REFERENCES actor(id),
  CHECK (token_sha256 IS NULL OR length(token_sha256) = 32),
  CHECK ((token_sha256 IS NULL) = (id = 'actor_00000000000000000000000000')),
  CHECK ((registered_by IS NULL) = (id = 'actor_00000000000000000000000000')),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
) STRICT`;

export const eventTableDdl = `CREATE TABLE event (
  id           TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('human', 'daemon', 'harness')),
  actor_id     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  CHECK (actor_kind <> 'harness' OR actor_id LIKE 'actor\\_%' ESCAPE '\\')
) STRICT`;

export const migration0005Actor: Migration = {
  version: 5,
  name: "0005-actor",
  statements: [
    actorTableDdl,
    `INSERT INTO actor (id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by) VALUES ('actor_00000000000000000000000000', 'human', 'bootstrap', NULL, NULL, 0, NULL, NULL)`,
    `ALTER TABLE event RENAME TO event_old`,
    eventTableDdl,
    `INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event_old`,
    `DROP TABLE event_old`,
    `CREATE INDEX event_subject ON event (subject_kind, subject_id, id)`,
    `CREATE INDEX event_type ON event (type, id)`,
    `CREATE INDEX event_actor ON event (actor_kind, actor_id, id)`,
  ],
};
