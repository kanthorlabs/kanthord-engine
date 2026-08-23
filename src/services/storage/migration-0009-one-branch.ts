import type { Migration } from "./migration.ts";

export const migration0009OneBranch: Migration = {
  version: 9,
  name: "0009-one-branch",
  statements: [
    "CREATE TEMP TABLE migration_0009_guard (name TEXT NOT NULL)",
    `CREATE TEMP TRIGGER migration_0009_refuse BEFORE INSERT ON migration_0009_guard BEGIN
  SELECT RAISE(ABORT, 'the repository ' || NEW.name || ' cannot be migrated to one branch field; pick one branch and register the repository again');
END`,
    `INSERT INTO migration_0009_guard (name)
  SELECT name FROM repository
  WHERE landing_branch <> upstream_branch
     OR publish_ref <> 'refs/heads/' || upstream_branch
  ORDER BY name LIMIT 1`,
    "DROP TRIGGER migration_0009_refuse",
    "DROP TABLE migration_0009_guard",
    "ALTER TABLE repository RENAME COLUMN upstream_branch TO branch",
    "ALTER TABLE repository DROP COLUMN landing_branch",
    "ALTER TABLE repository DROP COLUMN publish_ref",
  ],
};
