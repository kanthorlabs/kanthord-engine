import type { Storage } from "../../services/storage/index.ts";

export type ReadMigrationStatusDependencies = Readonly<{ storage: Storage }>;

export type MigrationLine = Readonly<{
  version: number;
  name: string;
  applied: boolean;
  appliedAt: number | null;
}>;

export type ReadMigrationStatusResult = Readonly<{
  migrations: readonly MigrationLine[];
}>;

export function readMigrationStatus(
  dependencies: ReadMigrationStatusDependencies,
): ReadMigrationStatusResult {
  const status = dependencies.storage.status();
  const lines: MigrationLine[] = [
    ...status.applied.map((entry) => ({
      version: entry.version,
      name: entry.name,
      applied: true,
      appliedAt: entry.appliedAt,
    })),
    ...status.pending.map((entry) => ({
      version: entry.version,
      name: entry.name,
      applied: false,
      appliedAt: null,
    })),
  ];
  lines.sort((a, b) => a.version - b.version);
  return { migrations: lines };
}
