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
import { listProviders } from "./list-provider.ts";
import type { ProviderListItem } from "./list-provider.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";

function generateKey(file: string): string {
  execFileSync(
    resolveTools().paths.sshKeygen,
    ["-t", "ed25519", "-N", "", "-f", file],
    { env: {}, encoding: "utf8" },
  );
  return readFileSync(file, "utf8");
}

describe("src/queries/provider/list-provider.test", () => {
  const crypto: Crypto = new AesGcmCrypto({
    key: Buffer.alloc(32, 7),
    keyVersion: 1,
  });

  let plainKey = "";
  const keyDirectory = mkdtempSync(join(tmpdir(), "kanthord-list-provider-"));

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
    };
  }

  function register(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
    name: string,
    kind: ProviderKind,
    payload: unknown,
  ): void {
    registerProvider(deps(storage, ids, clock), {
      name,
      kind,
      payload,
      actor: "ulrich",
    });
  }

  function items(storage: Storage): readonly ProviderListItem[] {
    return listProviders({ storage, crypto }, {});
  }

  it("returns three registrations in ascending id order, not insertion or name order", (t) => {
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
      ],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const body = {
      transport: "http-basic",
      forge: "github",
      username: "kanthord-bot",
      token: "ghp_x",
    };
    register(temporary.storage, ids, clock, "charlie", "git", body);
    register(temporary.storage, ids, clock, "bravo", "git", body);
    register(temporary.storage, ids, clock, "alpha", "git", body);

    const result = items(temporary.storage);
    assert.deepEqual(
      result.map((item) => item.id),
      [
        `provider_${"01HZY8QF3M4N5P6R7S8T9V0W1X"}`,
        `provider_${"01HZY8QF3M4N5P6R7S8T9V0W1Z"}`,
        `provider_${"01HZY8QF3M4N5P6R7S8T9V0W21"}`,
      ],
    );
    assert.deepEqual(
      result.map((item) => item.name),
      ["charlie", "bravo", "alpha"],
    );
  });

  it("every item carries a projection and no credential field", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        "01HZY8QF3M4N5P6R7S8T9V0W1X",
        "01HZY8QF3M4N5P6R7S8T9V0W1Y",
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
        "01HZY8QF3M4N5P6R7S8T9V0W20",
        "01HZY8QF3M4N5P6R7S8T9V0W21",
      ],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    register(temporary.storage, ids, clock, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "kanthord-bot",
      token: "ghp_x",
    });
    register(temporary.storage, ids, clock, "anthropic-bot", "llm", {
      provider: "anthropic",
      apiKey: "sk-ant-x",
      defaultModel: "claude-opus-5",
      baseUrl: null,
    });

    for (const item of items(temporary.storage)) {
      assert.ok(item.projection !== null);
      assert.equal(Object.hasOwn(item.projection, "apiKey"), false);
      assert.equal(Object.hasOwn(item.projection, "token"), false);
      assert.equal(Object.hasOwn(item.projection, "privateKey"), false);
    }
  });

  it("a kind filter returns only the matching rows in the same order", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        "01HZY8QF3M4N5P6R7S8T9V0W1X",
        "01HZY8QF3M4N5P6R7S8T9V0W1Y",
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
        "01HZY8QF3M4N5P6R7S8T9V0W20",
        "01HZY8QF3M4N5P6R7S8T9V0W21",
      ],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    register(temporary.storage, ids, clock, "github-bot", "git", {
      transport: "http-basic",
      forge: "github",
      username: "kanthord-bot",
      token: "ghp_x",
    });
    register(temporary.storage, ids, clock, "anthropic-bot", "llm", {
      provider: "anthropic",
      apiKey: "sk-ant-x",
      defaultModel: "claude-opus-5",
      baseUrl: null,
    });

    const result = listProviders(
      { storage: temporary.storage, crypto },
      { kind: "git" },
    );
    assert.equal(result.length, 1);
    assert.equal(result[0]?.name, "github-bot");
    assert.equal(result[0]?.kind, "git");
  });

  it("regression: a broken payload is reported as projection null, not dropped", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: ["01HZY8QF3M4N5P6R7S8T9V0W1X", "01HZY8QF3M4N5P6R7S8T9V0W1Y"],
    });
    register(
      temporary.storage,
      ids,
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
    const id = `provider_${"01HZY8QF3M4N5P6R7S8T9V0W1X"}`;
    temporary.storage.transact((transaction) =>
      transaction.run("UPDATE provider SET payload_tag = ? WHERE id = ?", [
        new Uint8Array(16),
        id,
      ]),
    );

    const result = items(temporary.storage);
    assert.equal(result.length, 1);
    const item = result[0]!;
    assert.equal(item.projection, null);
    assert.equal(item.id, id);
    assert.equal(item.name, "github-bot");
    assert.equal(item.kind, "git");
  });

  it("an empty table returns an empty list", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    assert.deepEqual(items(temporary.storage), []);
  });

  it("regression: the statement names its columns", () => {
    const source = readFileSync(
      new URL("./list-provider.ts", import.meta.url),
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
});
