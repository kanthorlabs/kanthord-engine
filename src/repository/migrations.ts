import type { Migration } from "../kernel/store.ts";

const createRepositoryTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE repository_host_key (
      id TEXT NOT NULL PRIMARY KEY,
      host TEXT NOT NULL,
      public_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX repository_host_key_host ON repository_host_key (host);
  `);
};

export const repositoryMigrations: readonly Migration[] = [
  createRepositoryTables,
];
