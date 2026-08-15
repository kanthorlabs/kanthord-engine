import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NodeCryptoSecret } from "../../services/secret/node-crypto.ts";
import type { Secret } from "../../services/secret/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import { bootstrapActorId, parseActorToken } from "../../domain/actor.ts";
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
import { rotateActorToken } from "./rotate-actor-token.ts";

const ACTOR_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const ROTATE_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Z";
const REVOKE_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W20";
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

type LeaseRowReadback = Readonly<{
  subject_kind: string;
  subject_id: string;
  owner: string | null;
  fence: number;
  acquired_at: number | null;
  renewed_at: number | null;
  expires_at: number | null;
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

describe("src/commands/actor/rotate-actor-token.test", () => {
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

  function readLeases(storage: Storage): readonly LeaseRowReadback[] {
    return storage.transact((transaction) =>
      transaction.all(
        "SELECT subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at FROM lease",
      ),
    ) as readonly LeaseRowReadback[];
  }

  function readEvents(storage: Storage): readonly EventRowReadback[] {
    return storage.transact((transaction) =>
      transaction.all(
        "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event",
      ),
    ) as readonly EventRowReadback[];
  }

  it("a rotation replaces the digest and preserves every other column", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID, ROTATE_EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const registered = registerOne(temporary.storage, ids, clock);
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const before = readActor(temporary.storage, registered.id);

    const result = rotateActorToken(
      { storage: temporary.storage, secret, events, clock },
      { id: registered.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );
    assert.equal(result.view.id, registered.id);
    assert.equal(result.view.kind, "harness");
    assert.equal(result.view.name, "worker-a");
    assert.equal(result.view.revokedAt, null);
    assert.notEqual(result.token, registered.token);

    const parsed = parseActorToken(result.token);
    assert.notEqual(parsed, null);
    assert.equal(parsed!.actorId, registered.id);

    const after = readActor(temporary.storage, registered.id);
    assert.equal(after.id, before.id);
    assert.equal(after.name, before.name);
    assert.equal(after.kind, before.kind);
    assert.equal(after.registered_by, before.registered_by);
    assert.equal(after.created_at, before.created_at);
    assert.equal(after.revoked_at, before.revoked_at);
    assert.equal(after.revoked_by, before.revoked_by);
    assert.notDeepEqual(after.token_sha256, before.token_sha256);
    assert.deepEqual(
      after.token_sha256,
      new Uint8Array(secret.digest(parsed!.secret)),
    );
  });

  it("appends exactly one actor.tokenRotated event whose payload holds no token and no digest", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID, ROTATE_EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const registered = registerOne(temporary.storage, ids, clock);
    const events = new SqliteEventLog({ storage: temporary.storage, ids });

    rotateActorToken(
      { storage: temporary.storage, secret, events, clock },
      { id: registered.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );

    const rotatedEvents = readEvents(temporary.storage).filter(
      (event) => event.type === "actor.tokenRotated",
    );
    assert.equal(rotatedEvents.length, 1);
    const event = rotatedEvents[0]!;
    assert.equal(event.subject_kind, "actor");
    assert.equal(event.subject_id, registered.id);
    assert.equal(event.actor_kind, "human");
    assert.equal(event.actor_id, bootstrapActorId);
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(payload).sort(), [
      "actorId",
      "kind",
      "name",
      "rotatedAt",
      "rotatedBy",
    ]);
    assert.equal(payload.rotatedBy, bootstrapActorId);
    assert.equal(payload.rotatedAt, 1700000001000);
  });

  it("a rolled-back rotation leaves no event and the original digest", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [ACTOR_ULID, EVENT_ULID] });
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
    const before = readActor(temporary.storage, registered.id);
    const beforeActor = tableBytes(temporary.storage, "actor");
    const beforeEvent = tableBytes(temporary.storage, "event");

    assert.throws(
      () =>
        rotateActorToken(
          { storage: temporary.storage, secret, events, clock },
          { id: registered.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
        ),
      (error: unknown) =>
        error instanceof Error && error.message === "event append fails",
    );
    assert.deepEqual(
      readActor(temporary.storage, registered.id).token_sha256,
      before.token_sha256,
    );
    assert.equal(
      readEvents(temporary.storage).filter(
        (event) => event.type === "actor.tokenRotated",
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

  it("rotating the bootstrap actor throws bootstrap-actor and writes nothing", (t) => {
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
        rotateActorToken(
          { storage: temporary.storage, secret, events, clock },
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

  it("rotating a revoked actor throws actor-revoked and writes nothing", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID, REVOKE_EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const registered = registerOne(temporary.storage, ids, clock);
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    revokeActor(
      { storage: temporary.storage, events, clock },
      { id: registered.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );
    const beforeActor = tableBytes(temporary.storage, "actor");
    const beforeEvent = tableBytes(temporary.storage, "event");

    assert.throws(
      () =>
        rotateActorToken(
          { storage: temporary.storage, secret, events, clock },
          { id: registered.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
        ),
      (error: unknown) =>
        error instanceof ActorCommandError && error.refusal === "actor-revoked",
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

  it("a rotation preserves every lease the actor owns", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [ACTOR_ULID, EVENT_ULID, ROTATE_EVENT_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const registered = registerOne(temporary.storage, ids, clock);
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    temporary.storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO lease (subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          "node",
          "node_01HZY8QF3M4N5P6R7S8T9V0W30",
          "worker-a",
          1,
          1000,
          1000,
          2000,
        ],
      );
    });
    const before = readLeases(temporary.storage);

    rotateActorToken(
      { storage: temporary.storage, secret, events, clock },
      { id: registered.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );
    assert.deepEqual(readLeases(temporary.storage), before);
  });
});
