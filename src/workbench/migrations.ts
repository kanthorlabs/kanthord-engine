import type { Migration } from "../kernel/store.ts";

const createInviteTable: Migration = (database) => {
  database.exec(`
    CREATE TABLE workbench_invite (
      id TEXT NOT NULL PRIMARY KEY,
      session_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      invited_by TEXT NOT NULL,
      invited_by_name TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      invitee_name TEXT NOT NULL,
      project_ids TEXT NOT NULL
    );
    CREATE UNIQUE INDEX workbench_invite_token_hash ON workbench_invite (token_hash);
  `);
};

export const workbenchMigrations: readonly Migration[] = [createInviteTable];
