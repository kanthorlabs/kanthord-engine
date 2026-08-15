import type { Migration } from "./migration.ts";

export const migration0006RevisionOrigin: Migration = {
  version: 6,
  name: "0006-revision-origin",
  rebuild: true,
  statements: [
    `ALTER TABLE plan_revision RENAME TO plan_revision_old`,
    `CREATE TABLE plan_revision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  parent_id TEXT REFERENCES plan_revision(id),
  origin TEXT NOT NULL CHECK (origin IN ('import', 'node-write')),
  import_id TEXT,
  submitted_blob TEXT REFERENCES blob(hash),
  choices_blob TEXT REFERENCES blob(hash),
  accepted_blob TEXT NOT NULL REFERENCES blob(hash),
  UNIQUE (project_id, import_id),
  CHECK ((origin = 'import') = (import_id IS NOT NULL)),
  CHECK ((origin = 'import') = (submitted_blob IS NOT NULL)),
  CHECK ((origin = 'import') = (choices_blob IS NOT NULL))
) STRICT`,
    `INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) SELECT id, project_id, parent_id, 'import', import_id, submitted_blob, choices_blob, accepted_blob FROM plan_revision_old`,
    `DROP TABLE plan_revision_old`,
  ],
};
