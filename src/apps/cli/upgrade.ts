import { join } from "node:path";
import { audit, writePrivate } from "../../kernel/files.ts";
import { Store } from "../../kernel/store.ts";
import { directories } from "../../kernel/xdg.ts";
import { formatRows, rowWidth, type RowValue } from "../../kernel/rows.ts";

const STAMP_LENGTH = 15;
const UpgradeRow = {
  UpToDate: "up_to_date",
  Backup: "backup",
  Migrated: "migrated",
  Renamed: "renamed",
  Upgraded: "upgraded",
  ConfigVersion: "config_version",
} as const;
const UPGRADE_ROW_WIDTH = rowWidth(Object.values(UpgradeRow));

function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").slice(0, STAMP_LENGTH);
}

export async function upgrade(
  path: string,
  write: (text: string) => void,
  now: Date = new Date(),
): Promise<void> {
  const row = (name: string, value: RowValue) =>
    write(formatRows([[name, value]], [], UPGRADE_ROW_WIDTH));
  const { configuration, readConfig } = await import("../../config/index.ts");
  const { parseMapping } = await import("../../kernel/yaml.ts");
  const { upgradeConfig } = await import("../../config/upgrade.ts");
  const { serverMigrations, DATABASE_FILE, verifyMasterKey } =
    await import("../server/index.ts");
  const original = readConfig(path);
  const config = upgradeConfig(original);
  const databasePath = join(directories().data, DATABASE_FILE);
  const store = audit(databasePath, "file", true)
    ? new Store(databasePath)
    : null;
  try {
    const pending = store?.plan(serverMigrations).pending ?? [];
    if (store)
      verifyMasterKey(
        store,
        configuration(parseMapping(config.content ?? original)).getProperties()
          .master_key,
        path,
      );
    if (config.content === null && !pending.length) {
      row(UpgradeRow.UpToDate, path);
      return;
    }
    const stamp = backupStamp(now);
    if (config.content !== null) {
      const backup = `${path}.bak-${stamp}`;
      writePrivate(backup, original);
      row(UpgradeRow.Backup, backup);
    }
    if (store && pending.length) {
      const backup = `${databasePath}.bak-${stamp}`;
      store.backup(backup);
      row(UpgradeRow.Backup, backup);
      store.migrate(serverMigrations);
      for (const { service, from, to } of pending)
        row(UpgradeRow.Migrated, `${service} ${from} -> ${to}`);
    }
    if (config.content !== null) {
      writePrivate(path, config.content, true);
      for (const change of config.changes)
        row(UpgradeRow.Renamed, `${change.from} -> ${change.to}`);
      row(UpgradeRow.Upgraded, path);
      row(UpgradeRow.ConfigVersion, `${config.from} -> ${config.to}`);
    }
  } finally {
    store?.close();
  }
}
