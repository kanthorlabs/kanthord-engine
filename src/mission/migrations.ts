import type { Migration } from "../kernel/store.ts";

const createMissionTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE mission_mission (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE mission_node (
      id TEXT NOT NULL PRIMARY KEY,
      mission_id TEXT NOT NULL REFERENCES mission_mission(id),
      kind TEXT NOT NULL,
      filename TEXT NOT NULL,
      parent_id TEXT REFERENCES mission_node(id),
      state TEXT,
      attempt INTEGER,
      priority INTEGER,
      retired_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX mission_node_filename_active ON mission_node (mission_id, filename) WHERE retired_at IS NULL;
    CREATE TABLE mission_node_revision (
      node_id TEXT NOT NULL REFERENCES mission_node(id),
      revision INTEGER NOT NULL,
      filename TEXT NOT NULL,
      name TEXT NOT NULL,
      requirement TEXT NOT NULL,
      criterion TEXT NOT NULL,
      verifications TEXT NOT NULL,
      bindings TEXT NOT NULL,
      tasks TEXT,
      change TEXT NOT NULL,
      reason TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (node_id, revision)
    );
    CREATE TABLE mission_dependency (
      dependent_id TEXT NOT NULL REFERENCES mission_node(id),
      depends_on_id TEXT NOT NULL REFERENCES mission_node(id),
      mission_id TEXT NOT NULL REFERENCES mission_mission(id),
      PRIMARY KEY (dependent_id, depends_on_id)
    );
  `);
};

export const missionMigrations: readonly Migration[] = [createMissionTables];
