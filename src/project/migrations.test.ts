import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJSON } from "../kernel/json.ts";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
import { PROJECT_SERVICE_NAME } from "./contract.ts";
import { projectMigrations } from "./migrations.ts";

const MIGRATIONS_BEFORE_RENAME = 2;
const PROJECT_ID = "project_a";

const OLD_REPOSITORY_CONFIG = {
  available: true,
  platform: "github",
  address: "git@github.com:owner/repo.git",
  strategy: {
    baseBranch: "main",
    action: {
      name: "pull_request",
      follows: { type: "assessment_passed" },
    },
  },
  sshCredential: "ssh-github.com",
  credential: "github-token",
  projectPrompt: "Follow the repository conventions.",
  working_layer: { agents_md: true, project_prompt: false },
};
const NEW_REPOSITORY_CONFIG = {
  available: true,
  platform: "github",
  address: "git@github.com:owner/repo.git",
  strategy: {
    base_branch: "main",
    action: {
      name: "pull_request",
      follows: { type: "assessment_passed" },
    },
  },
  ssh_credential: "ssh-github.com",
  credential: "github-token",
  project_prompt: "Follow the repository conventions.",
  working_layer: { agents_md: true, project_prompt: false },
};
const OLD_WORKER_CONFIG = {
  worker: "kanthord-agent",
  instanceCount: 2,
  resourceBudget: { turns: 10, wallTimeMs: 1000 },
  entries: [
    {
      agent: "swe@1",
      agentProvider: "default",
      modelIdentifier: "claude-sonnet-4-5",
      reasoningEffort: "off",
    },
    { agent: "re@1", modelIdentifier: "claude-opus-4-5" },
  ],
};
const NEW_WORKER_CONFIG = {
  worker: "kanthord-agent",
  instance_count: 2,
  resource_budget: { turns: 10, wall_time_ms: 1000 },
  entries: [
    {
      agent: "swe@1",
      agent_provider: "default",
      model_identifier: "claude-sonnet-4-5",
      reasoning_effort: "off",
    },
    { agent: "re@1", model_identifier: "claude-opus-4-5" },
  ],
};
const STORAGE_CONFIG = {
  available: true,
  endpoint: "https://s3.example.com",
  bucket: "bucket",
  region: "us-east-1",
  prefix: "kanthord",
  credential: "s3-key",
};
const BINDINGS: ReadonlyArray<{
  id: string;
  resourceIdentity: string;
  oldConfig: unknown;
  newConfig: unknown;
  removedAt: number | null;
}> = [
  {
    id: "binding_repository",
    resourceIdentity: "repository:github:owner/repo",
    oldConfig: OLD_REPOSITORY_CONFIG,
    newConfig: NEW_REPOSITORY_CONFIG,
    removedAt: null,
  },
  {
    id: "binding_worker",
    resourceIdentity: "worker:kanthord:developer",
    oldConfig: OLD_WORKER_CONFIG,
    newConfig: NEW_WORKER_CONFIG,
    removedAt: null,
  },
  {
    id: "binding_worker_removed",
    resourceIdentity: "worker:kanthord:retired",
    oldConfig: OLD_WORKER_CONFIG,
    newConfig: NEW_WORKER_CONFIG,
    removedAt: 5,
  },
  {
    id: "binding_storage",
    resourceIdentity: "storage:s3:s3.example.com/bucket",
    oldConfig: STORAGE_CONFIG,
    newConfig: STORAGE_CONFIG,
    removedAt: null,
  },
];

test("project migration renames the keys of every stored binding configuration", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      {
        service: PROJECT_SERVICE_NAME,
        migrations: projectMigrations.slice(0, MIGRATIONS_BEFORE_RENAME),
      },
    ]);
    store.database
      .prepare(
        "INSERT INTO project_project (id, name, created_at) VALUES (?, ?, 0)",
      )
      .run(PROJECT_ID, "alpha");
    const insert = store.database.prepare(
      `INSERT INTO project_binding
       (id, project_id, name, resource_identity, revision, config, created_at, removed_at)
       VALUES (?, ?, ?, ?, 1, ?, 0, ?)`,
    );
    for (const binding of BINDINGS)
      insert.run(
        binding.id,
        PROJECT_ID,
        binding.id,
        binding.resourceIdentity,
        canonicalJSON(binding.oldConfig),
        binding.removedAt,
      );
    store.migrate([
      { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
    ]);
    const rows = store.database
      .prepare("SELECT id, config FROM project_binding ORDER BY id")
      .all();
    assert.deepEqual(
      rows.map((row) => ({ id: row.id, config: row.config })),
      [...BINDINGS]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((binding) => ({
          id: binding.id,
          config: canonicalJSON(binding.newConfig),
        })),
    );
  } finally {
    store.close();
  }
});
