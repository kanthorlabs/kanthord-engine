import { join } from "node:path";
import { audit, writePrivate } from "../../kernel/files.ts";
import { Store } from "../../kernel/store.ts";
import { directories } from "../../kernel/xdg.ts";
import type { Row } from "../../kernel/rows.ts";

const STAMP_LENGTH = 15;

function backupStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").slice(0, STAMP_LENGTH);
}

export async function upgrade(
  path: string,
  rows: Row[],
  now: Date = new Date(),
): Promise<void> {
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
      rows.push(["up_to_date", path]);
      return;
    }
    const stamp = backupStamp(now);
    if (config.content !== null) {
      const backup = `${path}.bak-${stamp}`;
      writePrivate(backup, original);
      rows.push(["backup", backup]);
    }
    if (store && pending.length) {
      const backup = `${databasePath}.bak-${stamp}`;
      store.backup(backup);
      rows.push(["backup", backup]);
      store.migrate(serverMigrations);
      for (const { service, from, to } of pending)
        rows.push(["migrated", `${service} ${from} -> ${to}`]);
    }
    if (config.content !== null) {
      writePrivate(path, config.content, true);
      for (const change of config.changes)
        rows.push(["renamed", `${change.from} -> ${change.to}`]);
      rows.push(
        ["upgraded", path],
        ["config_version", `${config.from} -> ${config.to}`],
      );
    }
  } finally {
    store?.close();
  }
}
