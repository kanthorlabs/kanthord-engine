import { join } from "node:path";
import { audit, writePrivate } from "../../kernel/files.ts";
import { Store } from "../../kernel/store.ts";
import { directories } from "../../kernel/xdg.ts";

const STAMP_LENGTH = 15;

function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").slice(0, STAMP_LENGTH);
}

export async function upgrade(
  path: string,
  write: (line: string) => void,
  now: Date = new Date(),
): Promise<void> {
  const { readConfig } = await import("../../config/index.ts");
  const { upgradeConfig } = await import("../../config/upgrade.ts");
  const { serverMigrations, DATABASE_FILE } =
    await import("../server/index.ts");
  const original = readConfig(path);
  const config = upgradeConfig(original);
  const databasePath = join(directories().data, DATABASE_FILE);
  const store = audit(databasePath, "file", true)
    ? new Store(databasePath)
    : null;
  try {
    const pending = store?.plan(serverMigrations).pending ?? [];
    if (config.content === null && !pending.length) {
      write(`Up to date: ${path}`);
      return;
    }
    const stamp = backupStamp(now);
    if (config.content !== null) {
      const backup = `${path}.bak-${stamp}`;
      writePrivate(backup, original);
      write(`Backup: ${backup}`);
    }
    if (store && pending.length) {
      const backup = `${databasePath}.bak-${stamp}`;
      store.backup(backup);
      write(`Backup: ${backup}`);
      store.migrate(serverMigrations);
      for (const { service, from, to } of pending)
        write(`Migrated ${service} from version ${from} to version ${to}`);
    }
    if (config.content !== null) {
      writePrivate(path, config.content, true);
      for (const change of config.changes)
        write(`Renamed ${change.from} to ${change.to}`);
      write(
        `Upgraded configuration version ${config.from} to configuration version ${config.to}: ${path}`,
      );
    }
  } finally {
    store?.close();
  }
}
