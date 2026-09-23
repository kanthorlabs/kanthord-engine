import type { Migration } from "../kernel/store.ts";

export const gatewayMigrations: readonly Migration[] = [
  (database) => {
    database.exec(`
      CREATE TABLE gateway_token_denylist (
        jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, banned_at INTEGER NOT NULL
      );
      CREATE TABLE gateway_idempotency (
        key TEXT NOT NULL, route TEXT NOT NULL, fingerprint TEXT NOT NULL,
        caller TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('in_progress', 'completed', 'secret')),
        response TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (key, caller)
      );
    `);
  },
];
