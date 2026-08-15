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
import { NodeCryptoSecret } from "../../../services/secret/node-crypto.ts";
import { SqliteEventLog } from "../../../services/event/sqlite.ts";
import type { Storage } from "../../../services/storage/index.ts";
import { parseActorToken } from "../../../domain/actor.ts";
import { actorRegisterResponse } from "../../contract/actor.ts";
import { registerActor } from "../../../commands/actor/register-actor.ts";
import type { RegisterActorInput } from "../../../commands/actor/register-actor.ts";
import { registerActorHandler } from "./register-actor.ts";

const ACTOR_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const ACTOR2_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Z";
const EVENT2_ULID = "01HZY8QF3M4N5P6R7S8T9V0W20";

describe("src/http/server/actor/register-actor.test", () => {
  async function buildApp(
    t: TestContext,
    configuredToken: string,
    ulids: readonly string[],
  ) {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secret = new NodeCryptoSecret();
    const ids = createMockIdGenerator({ ulids });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const app = await createTestApp({
      handlers: {
        "actor.register": registerActorHandler({
          registerActor: (input: RegisterActorInput) =>
            registerActor(
              { storage: temporary.storage, secret, ids, events, clock },
              input,
            ),
          configuredToken,
        }),
      },
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
    });
    return { app, temporary };
  }

  function actorCount(storage: Storage): number {
    const row = storage.transact((transaction) =>
      transaction.get("SELECT COUNT(*) AS c FROM actor"),
    ) as { c: number };
    return row.c;
  }

  it("POST /v1/actor with a valid body answers 200 and carries the token once", async (t) => {
    const { app } = await buildApp(t, "test-token", [ACTOR_ULID, EVENT_ULID]);
    const response = await app.post("/v1/actor").send({ name: "worker-a" });
    assert.equal(response.status, 200);
    const parsed = actorRegisterResponse.parse(response.body);
    assert.equal(parsed.id, `actor_${ACTOR_ULID}`);
    assert.equal(parsed.kind, "harness");
    assert.equal(parsed.name, "worker-a");
    assert.equal(parsed.registeredBy, BOOTSTRAP_ACTOR_FIXTURE.id);
    assert.equal(Object.keys(response.body).includes("token"), true);
    const token = response.body.token as string;
    const tokenParts = parseActorToken(token);
    assert.notEqual(tokenParts, null);
    assert.equal(tokenParts!.actorId, `actor_${ACTOR_ULID}`);
  });

  it("a body carrying a kind key answers 400 invalid-request", async (t) => {
    const { app } = await buildApp(t, "test-token", []);
    const response = await app
      .post("/v1/actor")
      .send({ name: "worker-a", kind: "harness" });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("an uppercase name, a leading-hyphen name and a 64-character name each answer 400 invalid-request", async (t) => {
    const { app } = await buildApp(t, "test-token", []);
    for (const name of ["Worker-A", "-worker-a", "a".repeat(64)]) {
      const response = await app.post("/v1/actor").send({ name });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "invalid-request");
    }
  });

  it("a registration under an empty configured token answers 400 with refusal no-configured-token", async (t) => {
    const { app, temporary } = await buildApp(t, "", []);
    const beforeActor = tableBytes(temporary.storage, "actor");
    const beforeEvent = tableBytes(temporary.storage, "event");
    const response = await app.post("/v1/actor").send({ name: "worker-a" });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "no-configured-token");
    assert.equal(
      tableBytes(temporary.storage, "actor").equals(beforeActor),
      true,
    );
    assert.equal(
      tableBytes(temporary.storage, "event").equals(beforeEvent),
      true,
    );
  });

  it("a duplicate name with no Idempotency-Key answers 400 with refusal name-taken", async (t) => {
    const { app, temporary } = await buildApp(t, "test-token", [
      ACTOR_ULID,
      EVENT_ULID,
      ACTOR2_ULID,
      EVENT2_ULID,
    ]);
    const first = await app.post("/v1/actor").send({ name: "worker-a" });
    assert.equal(first.status, 200);
    const second = await app.post("/v1/actor").send({ name: "worker-a" });
    assert.equal(second.status, 400);
    assert.equal(second.body.error.code, "invalid-request");
    assert.equal(second.body.error.details.refusal, "name-taken");
    assert.equal(actorCount(temporary.storage), 2);
  });

  it("a replay under the same Idempotency-Key returns the identical body and writes exactly one new row", async (t) => {
    const { app, temporary } = await buildApp(t, "test-token", [
      ACTOR_ULID,
      EVENT_ULID,
    ]);
    const first = await app
      .post("/v1/actor")
      .set("Idempotency-Key", "k1")
      .send({ name: "worker-a" });
    const replay = await app
      .post("/v1/actor")
      .set("Idempotency-Key", "k1")
      .send({ name: "worker-a" });
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);
    assert.equal(actorCount(temporary.storage), 2);
  });
});
