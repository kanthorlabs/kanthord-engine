import { join } from "node:path";
import { audit, writePrivate } from "../../kernel/files.ts";
import {
  Store,
  type Migrations,
  type PendingMigration,
} from "../../kernel/store.ts";
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

interface Target {
  store: Store;
  path: string;
  migrations: Migrations;
  pending: readonly PendingMigration[];
}

function openTarget(path: string, migrations: Migrations): Target | null {
  if (!audit(path, "file", true)) return null;
  const store = new Store(path);
  try {
    return { store, path, migrations, pending: store.plan(migrations).pending };
  } catch (error) {
    store.close();
    throw error;
  }
}

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
  const {
    serverMigrations,
    trackingDatabaseMigrations,
    DATABASE_FILE,
    TRACKING_DATABASE_FILE,
    verifyMasterKey,
  } = await import("../server/index.ts");
  const original = readConfig(path);
  const config = upgradeConfig(original);
  const targets: Target[] = [];
  try {
    const server = openTarget(
      join(directories().data, DATABASE_FILE),
      serverMigrations,
    );
    if (server) targets.push(server);
    const tracking = openTarget(
      join(directories().data, TRACKING_DATABASE_FILE),
      trackingDatabaseMigrations,
    );
    if (tracking) targets.push(tracking);
    if (server)
      verifyMasterKey(
        server.store,
        configuration(parseMapping(config.content ?? original)).getProperties()
          .master_key,
        path,
      );
    const behind = targets.filter(({ pending }) => pending.length);
    if (config.content === null && !behind.length) {
      row(UpgradeRow.UpToDate, path);
      return;
    }
    const stamp = backupStamp(now);
    if (config.content !== null) {
      const backup = `${path}.bak-${stamp}`;
      writePrivate(backup, original);
      row(UpgradeRow.Backup, backup);
    }
    for (const { store, path: databasePath, migrations } of behind) {
      const backup = `${databasePath}.bak-${stamp}`;
      store.backup(backup);
      row(UpgradeRow.Backup, backup);
      store.migrate(migrations, ({ service, from, to }) =>
        row(UpgradeRow.Migrated, `${service} ${from} -> ${to}`),
      );
    }
    if (config.content !== null) {
      writePrivate(path, config.content, true);
      for (const change of config.changes)
        row(UpgradeRow.Renamed, `${change.from} -> ${change.to}`);
      row(UpgradeRow.Upgraded, path);
      row(UpgradeRow.ConfigVersion, `${config.from} -> ${config.to}`);
    }
  } finally {
    for (const { store } of targets) store.close();
  }
}
