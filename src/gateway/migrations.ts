import type { Migration } from "../kernel/store.ts";

export const gatewayMigrations: readonly Migration[] = [
  (database) => {
    database.exec(`
      CREATE TABLE gateway_token_denylist (
        jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, banned_at INTEGER NOT NULL
      );
    `);
  },
];
