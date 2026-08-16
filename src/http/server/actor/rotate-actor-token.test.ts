import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  createTestApp,
  BOOTSTRAP_ACTOR_FIXTURE,
} from "../../../../test/helpers/app.ts";
import {
  createMigratedStorage,
  tableBytes,
} from "../../../../test/helpers/database.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../../test/helpers/ids.ts";
import { createBackedLeaseFake } from "../../../../test/helpers/lease.ts";
import { NodeCryptoSecret } from "../../../services/secret/node-crypto.ts";
import { SqliteEventLog } from "../../../services/event/sqlite.ts";
import type { Storage } from "../../../services/storage/index.ts";
import { bootstrapActorId, parseActorToken } from "../../../domain/actor.ts";
import { actorRotateResponse } from "../../contract/actor.ts";
import { registerActor } from "../../../commands/actor/register-actor.ts";
import { revokeActor } from "../../../commands/actor/revoke-actor.ts";
import { rotateActorToken } from "../../../commands/actor/rotate-actor-token.ts";
import type { RotateActorTokenInput } from "../../../commands/actor/rotate-actor-token.ts";
import { rotateActorTokenHandler } from "./rotate-actor-token.ts";

const ACTOR_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const ROTATE_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Z";
const REVOKE_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W20";
const SECOND_ROTATE_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W21";
const UNKNOWN_ACTOR_ID = "actor_01HZY8QF3M4N5P6R7S8T9V0W22";

describe("src/http/server/actor/rotate-actor-token.test", () => {
  async function buildApp(t: TestContext, ulids: readonly string[]) {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secret = new NodeCryptoSecret();
    const ids = createMockIdGenerator({ ulids });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const app = await createTestApp({
      handlers: {
        "actor.rotate": rotateActorTokenHandler({
          rotateActorToken: (input: RotateActorTokenInput) =>
            rotateActorToken(
              { storage: temporary.storage, secret, events, clock },
              input,
            ),
        }),
      },
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
    });
    return { app, temporary, secret, ids, clock, events };
  }

  function storedDigest(storage: Storage, id: string): Uint8Array | null {
    const row = storage.transact((transaction) =>
      transaction.get("SELECT token_sha256 FROM actor WHERE id = ?", [id]),
    ) as { token_sha256: Uint8Array | null };
    return row.token_sha256;
  }

  it("POST /v1/actor/<bootstrapActorId>/rotate answers 400 with refusal bootstrap-actor", async (t) => {
    const { app, temporary } = await buildApp(t, []);
    const beforeActor = tableBytes(temporary.storage, "actor");
    const beforeEvent = tableBytes(temporary.storage, "event");
    const response = await app.post(`/v1/actor/${bootstrapActorId}/rotate`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "bootstrap-actor");
    assert.equal(
      tableBytes(temporary.storage, "actor").equals(beforeActor),
      true,
    );
    assert.equal(
      tableBytes(temporary.storage, "event").equals(beforeEvent),
      true,
    );
  });

  it("POST /v1/actor/<revoked id>/rotate answers 400 with refusal actor-revoked", async (t) => {
    const { app, temporary, ids, clock, events } = await buildApp(t, [
      ACTOR_ULID,
      EVENT_ULID,
      REVOKE_EVENT_ULID,
    ]);
    const secret = new NodeCryptoSecret();
    const registered = registerActor(
      { storage: temporary.storage, secret, ids, events, clock },
      {
        name: "worker-a",
        actor: BOOTSTRAP_ACTOR_FIXTURE,
        configuredToken: "test-token",
      },
    );
    revokeActor(
      {
        storage: temporary.storage,
        events,
        clock,
        lease: createBackedLeaseFake().lease,
      },
      { id: registered.view.id, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );
    const beforeActor = tableBytes(temporary.storage, "actor");
    const beforeEvent = tableBytes(temporary.storage, "event");

    const response = await app.post(`/v1/actor/${registered.view.id}/rotate`);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "actor-revoked");
    assert.equal(
      tableBytes(temporary.storage, "actor").equals(beforeActor),
      true,
    );
    assert.equal(
      tableBytes(temporary.storage, "event").equals(beforeEvent),
      true,
    );
  });

  it("POST /v1/actor/<unknown>/rotate answers 404 with the no actor message", async (t) => {
    const { app } = await buildApp(t, []);
    const response = await app.post(`/v1/actor/${UNKNOWN_ACTOR_ID}/rotate`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.equal(response.body.error.message, `no actor ${UNKNOWN_ACTOR_ID}`);
  });

  it("a replay under the same Idempotency-Key returns the same token and changes the digest once, and a new key mints a third token", async (t) => {
    const { app, temporary, secret, ids, clock, events } = await buildApp(t, [
      ACTOR_ULID,
      EVENT_ULID,
      ROTATE_EVENT_ULID,
      SECOND_ROTATE_EVENT_ULID,
    ]);
    const registered = registerActor(
      { storage: temporary.storage, secret, ids, events, clock },
      {
        name: "worker-a",
        actor: BOOTSTRAP_ACTOR_FIXTURE,
        configuredToken: "test-token",
      },
    );

    const first = await app
      .post(`/v1/actor/${registered.view.id}/rotate`)
      .set("Idempotency-Key", "k1");
    const replay = await app
      .post(`/v1/actor/${registered.view.id}/rotate`)
      .set("Idempotency-Key", "k1");
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    const firstParsed = actorRotateResponse.parse(first.body);
    const firstToken = parseActorToken(firstParsed.token);
    assert.notEqual(firstToken, null);
    assert.deepEqual(
      storedDigest(temporary.storage, registered.view.id),
      new Uint8Array(secret.digest(firstToken!.secret)),
    );

    const second = await app
      .post(`/v1/actor/${registered.view.id}/rotate`)
      .set("Idempotency-Key", "k2");
    assert.equal(second.status, 200);
    assert.notEqual(second.body.token, first.body.token);
  });
});
