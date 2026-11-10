import { join } from "node:path";
import { audit, writePrivate } from "../../kernel/files.ts";
import {
  type Migrations,
  type PendingMigration,
  Store,
} from "../../kernel/store.ts";
import { directories } from "../../kernel/xdg.ts";
import { formatRows, type RowValue, rowWidth } from "../../kernel/rows.ts";
import { ConfigChangeKind } from "../../config/steps.ts";
import type { ConfigUpgrade } from "../../config/upgrade.ts";

const STAMP_LENGTH = 15;
const UpgradeRow = {
  UpToDate: "up_to_date",
  Backup: "backup",
  Migrated: "migrated",
  Renamed: "renamed",
  Removed: "removed",
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

type RowWriter = (name: string, value: RowValue) => void;

interface TargetSpec {
  file: string;
  migrations: Migrations;
}

interface ConfigFile {
  path: string;
  original: string;
}

interface BackupContext {
  stamp: string;
  row: RowWriter;
}

function openTargets(targets: Target[], specs: readonly TargetSpec[]): void {
  for (const { file, migrations } of specs) {
    const target = openTarget(join(directories().data, file), migrations);
    if (target) targets.push(target);
  }
}

function backupConfig(
  file: ConfigFile,
  config: ConfigUpgrade,
  context: BackupContext,
): void {
  if (config.content === null) return;
  const backup = `${file.path}.bak-${context.stamp}`;
  writePrivate(backup, file.original);
  context.row(UpgradeRow.Backup, backup);
}

function migrateTargets(
  behind: readonly Target[],
  stamp: string,
  row: RowWriter,
): void {
  for (const { store, path, migrations } of behind) {
    const backup = `${path}.bak-${stamp}`;
    store.backup(backup);
    row(UpgradeRow.Backup, backup);
    store.migrate(migrations, ({ service, from, to }) =>
      row(UpgradeRow.Migrated, `${service} ${from} -> ${to}`),
    );
  }
}

function writeConfig(
  path: string,
  config: ConfigUpgrade,
  row: RowWriter,
): void {
  if (config.content === null) return;
  writePrivate(path, config.content, true);
  for (const change of config.changes)
    if (change.kind === ConfigChangeKind.Rename)
      row(UpgradeRow.Renamed, `${change.from} -> ${change.to}`);
    else row(UpgradeRow.Removed, change.key);
  row(UpgradeRow.Upgraded, path);
  row(UpgradeRow.ConfigVersion, `${config.from} -> ${config.to}`);
}

export async function upgrade(
  path: string,
  write: (text: string) => void,
  now: Date = new Date(),
): Promise<void> {
  const row: RowWriter = (name, value) =>
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
    openTargets(targets, [
      { file: DATABASE_FILE, migrations: serverMigrations },
      { file: TRACKING_DATABASE_FILE, migrations: trackingDatabaseMigrations },
    ]);
    const server = targets.find(
      ({ migrations }) => migrations === serverMigrations,
    );
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
    backupConfig({ path, original }, config, { stamp, row });
    migrateTargets(behind, stamp, row);
    writeConfig(path, config, row);
  } finally {
    for (const { store } of targets) store.close();
  }
}
