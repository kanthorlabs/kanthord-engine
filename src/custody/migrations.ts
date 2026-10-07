import { canonicalJSON } from "../kernel/json.ts";
import type { Migration } from "../kernel/store.ts";
import { isObject } from "../kernel/values.ts";

const createCredentialTable: Migration = (database) => {
  database.exec(`
    CREATE TABLE credential (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT NOT NULL,
      revision INTEGER NOT NULL,
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE UNIQUE INDEX credential_name_revision ON credential (name, revision);
  `);
};

const OPENAI_COMPATIBLE_PLATFORM = "openai-compatible";
const COMPATIBLE_METADATA_KEYS: Readonly<Record<string, string>> = {
  baseUrl: "base_url",
};
const COMPATIBLE_MODEL_KEYS: Readonly<Record<string, string>> = {
  contextWindow: "context_window",
  maxTokens: "max_tokens",
  reasoningLevels: "reasoning_levels",
};

function renameKeys(
  value: Record<string, unknown>,
  keys: Readonly<Record<string, string>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      Object.hasOwn(keys, key) ? keys[key] : key,
      item,
    ]),
  );
}

function renameCompatibleMetadata(metadata: unknown): unknown {
  if (!isObject(metadata) || Array.isArray(metadata)) return metadata;
  const renamed = renameKeys(
    metadata as Record<string, unknown>,
    COMPATIBLE_METADATA_KEYS,
  );
  if (!Array.isArray(renamed.models)) return renamed;
  return {
    ...renamed,
    models: renamed.models.map((model) =>
      isObject(model) && !Array.isArray(model)
        ? renameKeys(model as Record<string, unknown>, COMPATIBLE_MODEL_KEYS)
        : model,
    ),
  };
}

const renameCompatibleMetadataKeys: Migration = (database) => {
  const update = database.prepare(
    "UPDATE credential SET metadata = ? WHERE id = ?",
  );
  const rows = database
    .prepare(
      "SELECT id, metadata FROM credential WHERE platform = ? AND metadata IS NOT NULL",
    )
    .all(OPENAI_COMPATIBLE_PLATFORM) as { id: string; metadata: string }[];
  for (const { id, metadata } of rows)
    update.run(
      canonicalJSON(renameCompatibleMetadata(JSON.parse(metadata))),
      id,
    );
};

export const custodyMigrations: readonly Migration[] = [
  createCredentialTable,
  renameCompatibleMetadataKeys,
];
