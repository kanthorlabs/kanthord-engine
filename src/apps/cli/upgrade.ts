import { join } from "node:path";
import { audit, writePrivate } from "../../kernel/files.ts";
import {
  type Migrations,
  type PendingMigration,
  Store,
} from "../../kernel/store.ts";
import { CUSTODY_SERVICE_NAME } from "../../custody/contract.ts";
import { directories } from "../../kernel/xdg.ts";
import { formatRows, type RowValue, rowWidth } from "../../kernel/rows.ts";
import { ConfigChangeKind } from "../../config/steps.ts";
import type { ConfigUpgrade } from "../../config/upgrade.ts";

const STAMP_LENGTH = 15;
const UpgradeRow = {
  UpToDate: "up_to_date",
  Backup: "backup",
  Dropped: "dropped",
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
  changed: readonly string[];
}

function inspect(
  store: Store,
  migrations: Migrations,
  resetChanged: boolean,
): Pick<Target, "pending" | "changed"> {
  const changed = resetChanged ? store.changedServices(migrations) : [];
  if (!changed.length)
    return { pending: store.plan(migrations).pending, changed };
  store.assertResettable(migrations, changed, CUSTODY_SERVICE_NAME);
  return { pending: [], changed };
}

function openTarget(
  path: string,
  migrations: Migrations,
  resetChanged: boolean,
): Target | null {
  if (!audit(path, "file", true)) return null;
  const store = new Store(path);
  try {
    return {
      store,
      path,
      migrations,
      ...inspect(store, migrations, resetChanged),
    };
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

function openTargets(
  targets: Target[],
  specs: readonly TargetSpec[],
  resetChanged: boolean,
): void {
  for (const { file, migrations } of specs) {
    const target = openTarget(
      join(directories().data, file),
      migrations,
      resetChanged,
    );
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
  for (const { store, path, migrations, changed } of behind) {
    const backup = `${path}.bak-${stamp}`;
    store.backup(backup);
    row(UpgradeRow.Backup, backup);
    if (changed.length)
      for (const table of store.resetServices(
        migrations,
        changed,
        CUSTODY_SERVICE_NAME,
      ))
        row(UpgradeRow.Dropped, table);
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

interface UpgradeSettings {
  now?: Date;
  resetChanged?: boolean;
}

export async function upgrade(
  path: string,
  write: (text: string) => void,
  { now = new Date(), resetChanged = false }: UpgradeSettings = {},
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
    openTargets(
      targets,
      [
        { file: DATABASE_FILE, migrations: serverMigrations },
        {
          file: TRACKING_DATABASE_FILE,
          migrations: trackingDatabaseMigrations,
        },
      ],
      resetChanged,
    );
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
    const behind = targets.filter(
      ({ pending, changed }) => pending.length || changed.length,
    );
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
