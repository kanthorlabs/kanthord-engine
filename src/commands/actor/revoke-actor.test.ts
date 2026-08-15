import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NodeCryptoSecret } from "../../services/secret/node-crypto.ts";
import type { Secret } from "../../services/secret/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import { bootstrapActorId } from "../../domain/actor.ts";
import { BOOTSTRAP_ACTOR_FIXTURE } from "../../../test/helpers/app.ts";
import {
  createMigratedStorage,
  tableBytes,
} from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { ActorCommandError } from "../../domain/actor-command-error.ts";
import { registerActor } from "./register-actor.ts";
import { revokeActor } from "./revoke-actor.ts";

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

describe("src/commands/actor/revoke-actor.test", () => {
  const secret: Secret = new NodeCryptoSecret();

  function registerDependencies(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
  ) {
    return {
      storage,
      secret,
      ids,
      clock,
      events: new SqliteEventLog({ storage, ids }),
    };
  }

  function registerOne(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
  ): { id: string; token: string } {
    const result = registerActor(registerDependencies(storage, ids, clock), {
      name: "worker-a",
      actor: BOOTSTRAP_ACTOR_FIXTURE,
      configuredToken: "test-token",
    });
    return { id: result.view.id, token: result.token };
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

  it("a revoke stamps revoked_at and revoked_by and appends exactly one actor.revoked event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID, REVOKE_EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const registered = registerOne(temporary.storage, ids, clock);
    const events = new SqliteEventLog({ storage: temporary.storage, ids });

    const view = revokeActor(
      { storage: temporary.storage, events, clock },
      { id: registered.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );
    assert.equal(view.id, registered.id);
    assert.equal(view.name, "worker-a");
    assert.equal(view.revokedAt, 1700000001000);
    assert.equal(view.revokedBy, bootstrapActorId);

    const row = readActor(temporary.storage, registered.id);
    assert.equal(row.revoked_at, 1700000001000);
    assert.equal(row.revoked_by, bootstrapActorId);

    const revokedEvents = readEvents(temporary.storage).filter(
      (event) => event.type === "actor.revoked",
    );
    assert.equal(revokedEvents.length, 1);
    const event = revokedEvents[0]!;
    assert.equal(event.subject_kind, "actor");
    assert.equal(event.subject_id, registered.id);
    assert.equal(event.actor_kind, "human");
    assert.equal(event.actor_id, bootstrapActorId);
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      "actorId",
      "kind",
      "leasesFenced",
      "name",
      "revokedAt",
      "revokedBy",
    ]);
    assert.equal(payload.revokedBy, bootstrapActorId);
    assert.equal(payload.leasesFenced, 0);
    assert.equal(payload.revokedAt, 1700000001000);
  });

  it("a second revoke returns the same view, writes nothing and appends no second event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID, REVOKE_EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const registered = registerOne(temporary.storage, ids, clock);
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const deps = { storage: temporary.storage, events, clock };
    const first = revokeActor(deps, {
      id: registered.id,
      actor: BOOTSTRAP_ACTOR_FIXTURE,
    });
    const before = readActor(temporary.storage, registered.id);

    const second = revokeActor(deps, {
      id: registered.id,
      actor: BOOTSTRAP_ACTOR_FIXTURE,
    });
    assert.deepEqual(second, first);
    assert.deepEqual(readActor(temporary.storage, registered.id), before);
    assert.equal(
      readEvents(temporary.storage).filter(
        (event) => event.type === "actor.revoked",
      ).length,
      1,
    );
  });

  it("revoking the bootstrap actor throws bootstrap-actor and writes nothing", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [ACTOR_ULID, EVENT_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    registerOne(temporary.storage, ids, clock);
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const beforeActor = tableBytes(temporary.storage, "actor");
    const beforeEvent = tableBytes(temporary.storage, "event");

    assert.throws(
      () =>
        revokeActor(
          { storage: temporary.storage, events, clock },
          { id: bootstrapActorId, actor: BOOTSTRAP_ACTOR_FIXTURE },
        ),
      (error: unknown) =>
        error instanceof ActorCommandError &&
        error.refusal === "bootstrap-actor",
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

  it("an unknown id throws not-found", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });

    assert.throws(
      () =>
        revokeActor(
          { storage: temporary.storage, events, clock },
          { id: `actor_${REVOKE_EVENT_ULID}`, actor: BOOTSTRAP_ACTOR_FIXTURE },
        ),
      (error: unknown) =>
        error instanceof ActorCommandError && error.refusal === "not-found",
    );
  });

  it("a rolled-back revocation leaves no event and no stamp", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const registered = registerOne(temporary.storage, ids, clock);
    const inner = new SqliteEventLog({ storage: temporary.storage, ids });
    const events: EventLog = {
      append() {
        throw new Error("event append fails");
      },
      list(filter, transaction) {
        return inner.list(filter, transaction);
      },
    };
    const beforeActor = tableBytes(temporary.storage, "actor");
    const beforeEvent = tableBytes(temporary.storage, "event");

    assert.throws(
      () =>
        revokeActor(
          { storage: temporary.storage, events, clock },
          { id: registered.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
        ),
      (error: unknown) =>
        error instanceof Error && error.message === "event append fails",
    );
    const row = readActor(temporary.storage, registered.id);
    assert.equal(row.revoked_at, null);
    assert.equal(row.revoked_by, null);
    assert.equal(
      readEvents(temporary.storage).filter(
        (event) => event.type === "actor.revoked",
      ).length,
      0,
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
});
