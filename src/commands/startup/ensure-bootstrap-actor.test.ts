import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Storage } from "../../services/storage/index.ts";
import { bootstrapActorId } from "../../domain/actor.ts";
import {
  createMigratedStorage,
  tableCounts,
} from "../../../test/helpers/database.ts";
import {
  ensureBootstrapActor,
  EnsureBootstrapActorError,
} from "./ensure-bootstrap-actor.ts";

const HARNESS_ID = "actor_01HZY8QF3M4N5P6R7S8T9V0W1X";
const CREATED_AT = 1700000000000;

function readActor(
  storage: Storage,
  id: string,
): Readonly<Record<string, unknown>> {
  return storage.transact((transaction) =>
    transaction.get(
      "SELECT id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by FROM actor WHERE id = ?",
      [id],
    ),
  ) as Readonly<Record<string, unknown>>;
}

function seedHarness(storage: Storage, name: string): void {
  storage.transact((transaction) =>
    transaction.run(
      "INSERT INTO actor (id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        HARNESS_ID,
        "harness",
        name,
        new Uint8Array(32),
        bootstrapActorId,
        CREATED_AT,
        null,
        null,
      ],
    ),
  );
}

describe("src/commands/startup/ensure-bootstrap-actor.test", () => {
  it("writes the configured actor into the bootstrap row name on a fresh database", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());

    const result = ensureBootstrapActor(
      { storage: temporary.storage },
      { actor: "ulrich" },
    );

    assert.deepEqual(result, { name: "ulrich", changed: true });
    assert.deepEqual(
      { ...readActor(temporary.storage, bootstrapActorId) },
      {
        id: bootstrapActorId,
        kind: "human",
        name: "ulrich",
        token_sha256: null,
        registered_by: null,
        created_at: 0,
        revoked_at: null,
        revoked_by: null,
      },
    );
    assert.equal(tableCounts(temporary.storage).actor, 1);
  });

  it("a second call with the same name returns changed false and writes nothing", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());

    const first = ensureBootstrapActor(
      { storage: temporary.storage },
      { actor: "ulrich" },
    );
    assert.equal(first.changed, true);

    const before = { ...readActor(temporary.storage, bootstrapActorId) };
    const second = ensureBootstrapActor(
      { storage: temporary.storage },
      { actor: "ulrich" },
    );
    assert.deepEqual(second, { name: "ulrich", changed: false });
    assert.deepEqual(
      { ...readActor(temporary.storage, bootstrapActorId) },
      before,
    );
    assert.equal(tableCounts(temporary.storage).actor, 1);
  });

  it("a name held by a registered harness throws the refusal and names the conflicting id", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedHarness(temporary.storage, "harness-a");

    assert.throws(
      () =>
        ensureBootstrapActor(
          { storage: temporary.storage },
          { actor: "harness-a" },
        ),
      (error: unknown) =>
        error instanceof EnsureBootstrapActorError &&
        error.refusal === "actor-name-taken" &&
        error.message.includes("harness-a") &&
        error.message.includes(HARNESS_ID),
    );
    assert.equal(
      readActor(temporary.storage, bootstrapActorId).name,
      "bootstrap",
    );
    assert.equal(tableCounts(temporary.storage).actor, 2);
  });

  it("names outside the actor name pattern are accepted and written", (t) => {
    for (const name of ["Ulrich", "tuan.nguyen"]) {
      const temporary = createMigratedStorage();
      t.after(() => temporary.dispose());

      const result = ensureBootstrapActor(
        { storage: temporary.storage },
        { actor: name },
      );
      assert.deepEqual(result, { name, changed: true });
      assert.equal(readActor(temporary.storage, bootstrapActorId).name, name);
      assert.equal(tableCounts(temporary.storage).actor, 1);
    }
  });
});
