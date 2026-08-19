import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AesGcmCrypto } from "../../services/crypto/aes-gcm.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { ProviderKind } from "../../domain/provider-payload.ts";
import { registerProvider } from "../../commands/provider/register-provider.ts";
import type { RegisterProviderDependencies } from "../../commands/provider/register-provider.ts";
import { showProvider } from "./show-provider.ts";
import type { ProviderListItem } from "./show-provider.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import { createFakeModelCatalog } from "../../../test/helpers/model-catalog.ts";

function generateKey(file: string): string {
  execFileSync(
    resolveTools().paths.sshKeygen,
    ["-t", "ed25519", "-N", "", "-f", file],
    { env: {}, encoding: "utf8" },
  );
  return readFileSync(file, "utf8");
}

describe("src/queries/provider/show-provider.test", () => {
  const crypto: Crypto = new AesGcmCrypto({
    key: Buffer.alloc(32, 7),
    keyVersion: 1,
  });

  let plainKey = "";
  const keyDirectory = mkdtempSync(join(tmpdir(), "kanthord-show-provider-"));

  before(() => {
    plainKey = generateKey(join(keyDirectory, "plain"));
  });

  after(() => {
    rmSync(keyDirectory, { recursive: true, force: true });
  });

  function deps(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
  ): RegisterProviderDependencies {
    return {
      storage,
      crypto,
      ids,
      clock,
      events: new SqliteEventLog({ storage, ids }),
      catalog: createFakeModelCatalog(),
    };
  }

  function register(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
    name: string,
    kind: ProviderKind,
    payload: unknown,
  ): string {
    const view = registerProvider(deps(storage, ids, clock), {
      name,
      kind,
      payload,
      actor: "ulrich",
    });
    return view.id;
  }

  function show(storage: Storage, id: string): ProviderListItem | null {
    return showProvider({ storage, crypto }, { id });
  }

  it("returns the view of a registered id, field by field", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(
      temporary.storage,
      createMockIdGenerator({
        ulids: ["01HZY8QF3M4N5P6R7S8T9V0W1X", "01HZY8QF3M4N5P6R7S8T9V0W1Y"],
      }),
      createMockClock({ start: 1700000000000, step: 1000 }),
      "github-bot",
      "git",
      {
        transport: "http-basic",
        forge: "github",
        username: "kanthord-bot",
        token: "ghp_x",
      },
    );

    const item = show(temporary.storage, id);
    assert.ok(item !== null);
    assert.equal(item.id, id);
    assert.equal(item.name, "github-bot");
    assert.equal(item.kind, "git");
    assert.equal(item.setDefaultAt, null);
    assert.equal(item.updatedAt, 1700000000000);
    assert.deepEqual(item.projection, {
      transport: "http-basic",
      forge: "github",
      username: "kanthord-bot",
    });
  });

  it("returns null for an unknown but well-formed id", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    assert.equal(
      show(temporary.storage, "provider_01HZY8QF3M4N5P6R7S8T9V0W1X"),
      null,
    );
  });

  it("regression: returns projection null for a broken payload", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const id = register(
      temporary.storage,
      createMockIdGenerator({
        ulids: ["01HZY8QF3M4N5P6R7S8T9V0W1X", "01HZY8QF3M4N5P6R7S8T9V0W1Y"],
      }),
      createMockClock({ start: 1700000000000, step: 1000 }),
      "github-bot",
      "git",
      {
        transport: "http-basic",
        forge: "github",
        username: "kanthord-bot",
        token: "ghp_x",
      },
    );
    temporary.storage.transact((transaction) =>
      transaction.run("UPDATE provider SET payload_tag = ? WHERE id = ?", [
        new Uint8Array(16),
        id,
      ]),
    );

    const item = show(temporary.storage, id);
    assert.ok(item !== null);
    assert.equal(item.projection, null);
    assert.equal(item.id, id);
    assert.equal(item.name, "github-bot");
    assert.equal(item.kind, "git");
  });

  it("regression: the statement names its columns and rejects a star select", () => {
    const source = readFileSync(
      new URL("./show-provider.ts", import.meta.url),
      "utf8",
    );
    assert.equal(
      source.includes(
        "id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at",
      ),
      true,
    );
    assert.equal(/select\s*\*/i.test(source), false);
  });

  it("each kind returns that kind's projection, asserted field by field", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        "01HZY8QF3M4N5P6R7S8T9V0W1X",
        "01HZY8QF3M4N5P6R7S8T9V0W1Y",
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
        "01HZY8QF3M4N5P6R7S8T9V0W20",
        "01HZY8QF3M4N5P6R7S8T9V0W21",
        "01HZY8QF3M4N5P6R7S8T9V0W22",
        "01HZY8QF3M4N5P6R7S8T9V0W23",
      ],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const llmId = register(
      temporary.storage,
      ids,
      clock,
      "anthropic-bot",
      "llm",
      {
        provider: "openai-compatible",
        apiKey: "sk-ant-x",
        defaultModel: "claude-opus-5",
        baseUrl: "https://example.invalid/v1",
      },
    );
    const httpId = register(
      temporary.storage,
      ids,
      clock,
      "github-bot",
      "git",
      {
        transport: "http-basic",
        forge: "github",
        username: "kanthord-bot",
        token: "ghp_x",
      },
    );
    const sshId = register(temporary.storage, ids, clock, "ssh-bot", "git", {
      transport: "ssh",
      privateKey: plainKey,
    });

    const subjects: ReadonlyArray<{
      id: string;
      keys: readonly string[];
      values: Readonly<Record<string, unknown>>;
    }> = [
      {
        id: llmId,
        keys: ["baseUrl", "defaultModel", "provider"],
        values: {
          provider: "openai-compatible",
          defaultModel: "claude-opus-5",
          baseUrl: "https://example.invalid/v1",
        },
      },
      {
        id: httpId,
        keys: ["forge", "transport", "username"],
        values: {
          transport: "http-basic",
          forge: "github",
          username: "kanthord-bot",
        },
      },
      {
        id: sshId,
        keys: ["forge", "transport", "username"],
        values: { transport: "ssh", forge: null, username: null },
      },
    ];

    for (const subject of subjects) {
      const item = show(temporary.storage, subject.id);
      assert.ok(item !== null);
      assert.ok(item.projection !== null);
      assert.deepEqual(
        Object.keys(item.projection).sort(),
        [...subject.keys].sort(),
      );
      for (const [key, value] of Object.entries(subject.values)) {
        assert.deepEqual(
          (item.projection as Readonly<Record<string, unknown>>)[key],
          value,
          `projection[${key}] of ${subject.id}`,
        );
      }
      assert.equal(Object.hasOwn(item.projection, "apiKey"), false);
      assert.equal(Object.hasOwn(item.projection, "token"), false);
      assert.equal(Object.hasOwn(item.projection, "privateKey"), false);
    }
  });
});
