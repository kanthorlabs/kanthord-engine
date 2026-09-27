import type { Migration } from "../kernel/store.ts";

const createProjectTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE project_project (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      binding_set_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX project_project_name ON project_project (name);
    CREATE TABLE project_binding (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project_project(id),
      name TEXT NOT NULL,
      resource_identity TEXT NOT NULL,
      revision INTEGER NOT NULL,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      removed_at INTEGER
    );
    CREATE UNIQUE INDEX project_binding_revision ON project_binding (project_id, resource_identity, revision);
  `);
};

export const projectMigrations: readonly Migration[] = [createProjectTables];
