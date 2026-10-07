import assert from "node:assert/strict";
import { test } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { CUSTODY_SERVICE_NAME } from "./contract.ts";
import { custodyMigrations } from "./migrations.ts";

const INSERT_CREDENTIAL = `INSERT INTO credential
  (id, name, platform, revision, nonce, ciphertext, metadata, created_at, ended_at)
  VALUES (?, ?, ?, ?, x'00', x'00', ?, 1, ?)`;

test("custody migration renames the keys of every stored openai-compatible metadata", () => {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([
      {
        service: CUSTODY_SERVICE_NAME,
        migrations: custodyMigrations.slice(0, 1),
      },
    ]);
    const insert = store.database.prepare(INSERT_CREDENTIAL);
    insert.run(
      "credential_a",
      "compatible",
      "openai-compatible",
      1,
      JSON.stringify({
        baseUrl: "https://example.com/v1",
        models: [{ id: "baseUrl" }],
      }),
      2,
    );
    insert.run(
      "credential_b",
      "compatible",
      "openai-compatible",
      2,
      JSON.stringify({
        baseUrl: "https://example.com/v2",
        models: [
          {
            id: "full",
            contextWindow: 4096,
            maxTokens: 512,
            reasoningLevels: ["off", "high"],
          },
          { id: "plain" },
        ],
      }),
      null,
    );
    insert.run("credential_c", "bare", "openai-compatible", 1, null, null);
    insert.run(
      "credential_d",
      "bedrock",
      "amazon-bedrock",
      1,
      JSON.stringify({ region: "us-east-1", baseUrl: "kept" }),
      null,
    );
    store.migrate([
      { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
    ]);
    const metadataOf = (id: string) => {
      const row = store.database
        .prepare("SELECT metadata FROM credential WHERE id = ?")
        .get(id) as { metadata: string | null };
      return row.metadata === null ? null : JSON.parse(row.metadata);
    };
    assert.deepEqual(metadataOf("credential_a"), {
      base_url: "https://example.com/v1",
      models: [{ id: "baseUrl" }],
    });
    assert.deepEqual(metadataOf("credential_b"), {
      base_url: "https://example.com/v2",
      models: [
        {
          id: "full",
          context_window: 4096,
          max_tokens: 512,
          reasoning_levels: ["off", "high"],
        },
        { id: "plain" },
      ],
    });
    assert.equal(metadataOf("credential_c"), null);
    assert.deepEqual(metadataOf("credential_d"), {
      region: "us-east-1",
      baseUrl: "kept",
    });
  } finally {
    store.close();
  }
});
