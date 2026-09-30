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

const createExecutionRecordTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE mission_attempt (
      node_id TEXT NOT NULL REFERENCES mission_node(id),
      attempt INTEGER NOT NULL,
      node_revision INTEGER NOT NULL,
      opened_by TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      closed_at INTEGER,
      PRIMARY KEY (node_id, attempt)
    );
    CREATE UNIQUE INDEX mission_attempt_open ON mission_attempt (node_id) WHERE closed_at IS NULL;
    CREATE TABLE mission_evidence (
      id TEXT NOT NULL PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES mission_node(id),
      attempt INTEGER NOT NULL,
      subject TEXT NOT NULL,
      requirement_key TEXT,
      end_state TEXT,
      verification TEXT,
      provenance TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX mission_evidence_request ON mission_evidence (node_id, attempt, requirement_key) WHERE requirement_key IS NOT NULL;
    CREATE TABLE mission_evidence_asset (
      id TEXT NOT NULL PRIMARY KEY,
      evidence_id TEXT NOT NULL REFERENCES mission_evidence(id),
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      published_at INTEGER,
      expired_at INTEGER
    );
    CREATE TABLE mission_assessment (
      id TEXT NOT NULL PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES mission_node(id),
      sequence INTEGER NOT NULL,
      attempt INTEGER NOT NULL,
      result TEXT NOT NULL,
      rationale TEXT NOT NULL,
      evidence_ids TEXT NOT NULL,
      child_outcome_ids TEXT NOT NULL,
      tested_input TEXT,
      execution_id TEXT,
      actor TEXT,
      node_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX mission_assessment_sequence ON mission_assessment (node_id, sequence);
    CREATE TABLE mission_outcome (
      id TEXT NOT NULL PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES mission_node(id),
      sequence INTEGER NOT NULL,
      result TEXT NOT NULL,
      assessment_id TEXT NOT NULL REFERENCES mission_assessment(id),
      evidence_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX mission_outcome_sequence ON mission_outcome (node_id, sequence);
  `);
};

export const missionMigrations: readonly Migration[] = [
  createMissionTables,
  createExecutionRecordTables,
];
