import type { Migration } from "../kernel/store.ts";

const createIntakeTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE intake_inbound (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      platform TEXT NOT NULL,
      consumer TEXT NOT NULL,
      credential TEXT,
      configuration TEXT NOT NULL,
      checkpoint TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE intake_inbound_event (
      id TEXT NOT NULL PRIMARY KEY,
      inbound_id TEXT NOT NULL REFERENCES intake_inbound(id),
      event_id TEXT NOT NULL,
      event BLOB NOT NULL,
      metadata TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX intake_inbound_event_inbound_event ON intake_inbound_event (inbound_id, event_id);
    CREATE TABLE intake_outbound_request (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      request_key TEXT NOT NULL,
      credential TEXT,
      state TEXT NOT NULL,
      result TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX intake_outbound_request_operation_key ON intake_outbound_request (operation, request_key);
  `);
};

export const intakeMigrations: readonly Migration[] = [createIntakeTables];
