import type { Handler } from "../app.ts";
import type { ReadMigrationStatusResult } from "../../../queries/system/read-migration-status.ts";

export type DbHandlerDependencies = Readonly<{
  readMigrationStatus: () => ReadMigrationStatusResult;
}>;

export function dbHandler(dependencies: DbHandlerDependencies): Handler {
  return () => ({ status: 200, body: dependencies.readMigrationStatus() });
}
