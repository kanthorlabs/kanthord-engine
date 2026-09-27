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

export const schedulerMigrations: readonly Migration[] = [createJobTable];
