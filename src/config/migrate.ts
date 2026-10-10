import { parseDocument } from "yaml";
import { readPrivate, writePrivate } from "../kernel/files.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { parseMapping } from "../kernel/yaml.ts";
import { CONFIG_RENAMES, type ConfigRename } from "./renames.ts";
import { configuration } from "./index.ts";

const STAMP_LENGTH = 15;
const NO_CHANGES = 0;

export interface ConfigMigration {
  readonly changes: readonly ConfigRename[];
  readonly backup: string | null;
}

function backupPath(path: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, STAMP_LENGTH);
  return `${path}.bak-${stamp}`;
}

export function migrateConfig(
  path: string,
  now: Date = new Date(),
): ConfigMigration {
  const original = readPrivate(path);
  const document = parseDocument(original);
  const changes: ConfigRename[] = [];
  for (const rename of CONFIG_RENAMES) {
    const from = rename.from.split(".");
    const to = rename.to.split(".");
    if (!document.hasIn(from)) continue;
    if (document.hasIn(to))
      throw new Diagnostic(
        "system.config.rename_conflict",
        `${rename.from} and ${rename.to} are both present. Remove one of them.`,
      );
    document.setIn(to, document.getIn(from));
    document.deleteIn(from);
    changes.push(rename);
  }
  if (changes.length === NO_CHANGES) return { changes, backup: null };
  const migrated = document.toString();
  configuration(parseMapping(migrated));
  const backup = backupPath(path, now);
  writePrivate(backup, original);
  writePrivate(path, migrated, true);
  return { changes, backup };
}
