import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NodeCryptoSecret } from "../../services/secret/node-crypto.ts";
import type { Secret } from "../../services/secret/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import {
  bootstrapActorId,
  parseActorToken,
  renderActorToken,
} from "../../domain/actor.ts";
import { BOOTSTRAP_ACTOR_FIXTURE } from "../../../test/helpers/app.ts";
import {
  createMigratedStorage,
  tableBytes,
} from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { ActorCommandError } from "../../domain/actor-command-error.ts";
import { registerActor } from "./register-actor.ts";
import type {
  RegisterActorDependencies,
  RegisterActorInput,
} from "./register-actor.ts";

const ACTOR_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const REVOKE_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Z";
const actorId = `actor_${ACTOR_ULID}`;

type ActorRowReadback = Readonly<{
  id: string;
  kind: string;
  name: string;
  token_sha256: Uint8Array | null;
  registered_by: string | null;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}>;

type EventRowReadback = Readonly<{
  id: string;
  subject_kind: string;
  subject_id: string;
  type: string;
  actor_kind: string;
  actor_id: string;
  payload_json: string;
}>;

describe("src/commands/actor/register-actor.test", () => {
  const secret: Secret = new NodeCryptoSecret();

  function dependencies(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
  ): RegisterActorDependencies {
    return {
      storage,
      secret,
      ids,
      clock,
      events: new SqliteEventLog({ storage, ids }),
    };
  }

  function input(name: string): RegisterActorInput {
    return {
      name,
      actor: BOOTSTRAP_ACTOR_FIXTURE,
      configuredToken: "test-token",
    };
  }

  function countRows(storage: Storage, table: "actor" | "event"): number {
    const row = storage.transact((transaction) =>
      transaction.get(`SELECT COUNT(*) AS c FROM ${table}`),
    ) as { c: number };
    return row.c;
  }

  function readActor(storage: Storage, id: string): ActorRowReadback {
    return storage.transact((transaction) =>
      transaction.get(
        "SELECT id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by FROM actor WHERE id = ?",
        [id],
      ),
    ) as ActorRowReadback;
  }

  function readEvents(storage: Storage): readonly EventRowReadback[] {
    return storage.transact((transaction) =>
      transaction.all(
        "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event",
      ),
    ) as readonly EventRowReadback[];
  }

  it("a registration inserts exactly one harness row holding the digest of the returned secret", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [ACTOR_ULID, EVENT_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = dependencies(temporary.storage, ids, clock);

    const result = registerActor(deps, input("worker-a"));

    assert.equal(result.view.id, actorId);
    assert.equal(result.view.kind, "harness");
    assert.equal(result.view.name, "worker-a");
    assert.equal(result.view.registeredBy, bootstrapActorId);
    assert.equal(result.view.createdAt, 1700000000000);
    assert.equal(result.view.revokedAt, null);
    assert.equal(result.view.revokedBy, null);

    const parsed = parseActorToken(result.token);
    assert.notEqual(parsed, null);
    assert.equal(parsed!.actorId, actorId);
    assert.equal(renderActorToken(parsed!), result.token);

    const row = readActor(temporary.storage, actorId);
    assert.equal(row.id, actorId);
    assert.equal(row.kind, "harness");
    assert.equal(row.name, "worker-a");
    assert.equal(row.registered_by, bootstrapActorId);
    assert.equal(row.created_at, 1700000000000);
    assert.equal(row.revoked_at, null);
    assert.equal(row.revoked_by, null);
    assert.equal(row.token_sha256?.length, 32);
    assert.deepEqual(
      row.token_sha256,
      new Uint8Array(secret.digest(parsed!.secret)),
    );
  });

  it("appends exactly one actor.registered event whose payload holds no secret and no digest", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [ACTOR_ULID, EVENT_ULID] });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    registerActor(deps, input("worker-a"));

    const events = readEvents(temporary.storage);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.subject_kind, "actor");
    assert.equal(event.subject_id, actorId);
    assert.equal(event.type, "actor.registered");
    assert.equal(event.actor_kind, "human");
    assert.equal(event.actor_id, bootstrapActorId);
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      "actorId",
      "kind",
      "name",
      "registeredBy",
    ]);
    assert.deepEqual(payload, {
      actorId,
      kind: "harness",
      name: "worker-a",
      registeredBy: bootstrapActorId,
    });
  });

  it("an empty configured token refuses with no-configured-token and writes nothing", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [ACTOR_ULID, EVENT_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = dependencies(temporary.storage, ids, clock);
    registerActor(deps, input("worker-a"));
    const beforeActor = tableBytes(temporary.storage, "actor");
    const beforeEvent = tableBytes(temporary.storage, "event");

    assert.throws(
      () =>
        registerActor(deps, {
          name: "worker-b",
          actor: BOOTSTRAP_ACTOR_FIXTURE,
          configuredToken: "",
        }),
      (error: unknown) =>
        error instanceof ActorCommandError &&
        error.refusal === "no-configured-token",
    );
    assert.equal(
      tableBytes(temporary.storage, "actor").equals(beforeActor),
      true,
    );
    assert.equal(
      tableBytes(temporary.storage, "event").equals(beforeEvent),
      true,
    );
  });

  it("a duplicate name refuses with name-taken and rolls the write back", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [ACTOR_ULID, EVENT_ULID] });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    registerActor(deps, input("worker-a"));
    assert.throws(
      () => registerActor(deps, input("worker-a")),
      (error: unknown) =>
        error instanceof ActorCommandError && error.refusal === "name-taken",
    );
    assert.equal(countRows(temporary.storage, "actor"), 2);
    assert.equal(countRows(temporary.storage, "event"), 1);
  });

  it("a duplicate name refuses with name-taken even when the existing row is revoked", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID, REVOKE_EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = dependencies(temporary.storage, ids, clock);

    registerActor(deps, input("worker-a"));
    temporary.storage.transact((transaction) => {
      transaction.run(
        "UPDATE actor SET revoked_at = ?, revoked_by = ? WHERE id = ?",
        [1700000001000, bootstrapActorId, actorId],
      );
    });

    assert.throws(
      () => registerActor(deps, input("worker-a")),
      (error: unknown) =>
        error instanceof ActorCommandError && error.refusal === "name-taken",
    );
    assert.equal(countRows(temporary.storage, "actor"), 2);
    assert.equal(countRows(temporary.storage, "event"), 1);
  });

  it("a name outside the actor name pattern is accepted, because the boundary refuses it", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [ACTOR_ULID, EVENT_ULID] });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    const result = registerActor(deps, input("Worker-A"));
    assert.equal(result.view.id, actorId);
    assert.equal(result.view.name, "Worker-A");
    assert.equal(result.view.kind, "harness");
  });
});
