import { canonicalJSON } from "../kernel/json.ts";
import type { Migration } from "../kernel/store.ts";
import { isObject } from "../kernel/values.ts";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return isObject(value) && !Array.isArray(value);
}

const createProjectTables: Migration = (database) => {
  database.exec(`
    CREATE TABLE project_project (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL,
      binding_set_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX project_project_name ON project_project (name);
    CREATE TABLE project_binding (
      id TEXT NOT NULL PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES project_project(id),
      name TEXT NOT NULL,
      resource_identity TEXT NOT NULL,
      revision INTEGER NOT NULL,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      removed_at INTEGER
    );
    CREATE UNIQUE INDEX project_binding_revision ON project_binding (project_id, resource_identity, revision);
  `);
};

const dropBindingSetVersion: Migration = (database) => {
  database.exec("ALTER TABLE project_project DROP COLUMN binding_set_version;");
};

type KeyMap = Readonly<Record<string, string>>;

const REPOSITORY_CONFIG_KEYS: KeyMap = {
  sshCredential: "ssh_credential",
  projectPrompt: "project_prompt",
  workingLayer: "working_layer",
};
const REPOSITORY_STRATEGY_KEYS: KeyMap = { baseBranch: "base_branch" };
const WORKER_CONFIG_KEYS: KeyMap = {
  instanceCount: "instance_count",
  resourceBudget: "resource_budget",
};
const WORKER_BUDGET_KEYS: KeyMap = { wallTimeMs: "wall_time_ms" };
const WORKER_ENTRY_KEYS: KeyMap = {
  agentProvider: "agent_provider",
  modelIdentifier: "model_identifier",
  reasoningEffort: "reasoning_effort",
};
const REPOSITORY_KIND_PREFIX = "repository:";
const WORKER_KIND_PREFIX = "worker:";

function renameKeys(value: unknown, keys: KeyMap): unknown {
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      Object.hasOwn(keys, key) ? keys[key] : key,
      item,
    ]),
  );
}

function renameNested(value: unknown, key: string, keys: KeyMap): unknown {
  if (!isJsonObject(value) || !Object.hasOwn(value, key)) return value;
  return { ...value, [key]: renameKeys(value[key], keys) };
}

function renameRepositoryConfig(config: unknown): unknown {
  return renameKeys(
    renameNested(config, "strategy", REPOSITORY_STRATEGY_KEYS),
    REPOSITORY_CONFIG_KEYS,
  );
}

function renameWorkerEntries(config: unknown): unknown {
  if (!isJsonObject(config) || !Array.isArray(config.entries)) return config;
  return {
    ...config,
    entries: config.entries.map((entry) =>
      renameKeys(entry, WORKER_ENTRY_KEYS),
    ),
  };
}

function renameWorkerConfig(config: unknown): unknown {
  return renameKeys(
    renameWorkerEntries(
      renameNested(config, "resourceBudget", WORKER_BUDGET_KEYS),
    ),
    WORKER_CONFIG_KEYS,
  );
}

function renameBindingConfig(resourceIdentity: string, config: unknown) {
  if (resourceIdentity.startsWith(REPOSITORY_KIND_PREFIX))
    return renameRepositoryConfig(config);
  if (resourceIdentity.startsWith(WORKER_KIND_PREFIX))
    return renameWorkerConfig(config);
  return config;
}

const renameBindingConfigKeys: Migration = (database) => {
  const update = database.prepare(
    "UPDATE project_binding SET config = ? WHERE id = ?",
  );
  const rows = database
    .prepare("SELECT id, resource_identity, config FROM project_binding")
    .all() as { id: string; resource_identity: string; config: string }[];
  for (const { id, resource_identity, config } of rows)
    update.run(
      canonicalJSON(renameBindingConfig(resource_identity, JSON.parse(config))),
      id,
    );
};

export const projectMigrations: readonly Migration[] = [
  createProjectTables,
  dropBindingSetVersion,
  renameBindingConfigKeys,
];
