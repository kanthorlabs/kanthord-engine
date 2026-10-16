import type { Migration } from "../kernel/store.ts";

const createJobTable: Migration = (database) => {
  database.exec(`
    CREATE TABLE scheduler_job (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      priority INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX scheduler_job_node_id ON scheduler_job (node_id);
  `);
};

const createExecutionTable: Migration = (database) => {
  database.exec(`
    CREATE TABLE scheduler_execution (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      worker_binding_id TEXT NOT NULL,
      resource_identity TEXT NOT NULL,
      runtime_identity TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      pinned_revision INTEGER NOT NULL,
      credentials TEXT NOT NULL,
      expired_at INTEGER NOT NULL,
      trace_id TEXT NOT NULL,
      root_span_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE UNIQUE INDEX scheduler_execution_node_live ON scheduler_execution (node_id) WHERE ended_at IS NULL;
    CREATE UNIQUE INDEX scheduler_execution_runtime_live ON scheduler_execution (runtime_identity) WHERE ended_at IS NULL;
  `);
};

const addExecutionStop: Migration = (database) => {
  database.exec(`ALTER TABLE scheduler_execution ADD COLUMN stop TEXT;`);
};

const addExecutionNodeBranch: Migration = (database) => {
  database.exec(`
    ALTER TABLE scheduler_execution ADD COLUMN node_branch TEXT NOT NULL DEFAULT '';
    UPDATE scheduler_execution SET node_branch = 'kanthord/' || node_id;
  `);
};

const addExecutionAgentSelections: Migration = (database) => {
  database.exec(
    `ALTER TABLE scheduler_execution ADD COLUMN agent_selections TEXT;`,
  );
};

const addJobNotBefore: Migration = (database) => {
  database.exec(`ALTER TABLE scheduler_job ADD COLUMN not_before INTEGER;`);
};

export const schedulerMigrations: readonly Migration[] = [
  createJobTable,
  createExecutionTable,
  addExecutionStop,
  addExecutionNodeBranch,
  addExecutionAgentSelections,
  addJobNotBefore,
];
