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
import { SqliteEventLog } from "../../../services/event/sqlite.ts";
import { bootstrapActorId } from "../../../domain/actor.ts";
import { revokeActor } from "../../../commands/actor/revoke-actor.ts";
import type { RevokeActorInput } from "../../../commands/actor/revoke-actor.ts";
import { revokeActorHandler } from "./revoke-actor.ts";

const UNKNOWN_ACTOR_ID = "actor_01HZY8QF3M4N5P6R7S8T9V0W1X";

describe("src/http/server/actor/revoke-actor.test", () => {
  async function buildApp(t: TestContext) {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const app = await createTestApp({
      handlers: {
        "actor.revoke": revokeActorHandler({
          revokeActor: (input: RevokeActorInput) =>
            revokeActor({ storage: temporary.storage, events, clock }, input),
        }),
      },
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
    });
    return { app, temporary };
  }

  it("POST /v1/actor/<bootstrapActorId>/revoke answers 400 with refusal bootstrap-actor", async (t) => {
    const { app, temporary } = await buildApp(t);
    const beforeActor = tableBytes(temporary.storage, "actor");
    const beforeEvent = tableBytes(temporary.storage, "event");
    const response = await app.post(`/v1/actor/${bootstrapActorId}/revoke`);
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

  it("POST /v1/actor/<unknown>/revoke answers 404 with the no actor message", async (t) => {
    const { app } = await buildApp(t);
    const response = await app.post(`/v1/actor/${UNKNOWN_ACTOR_ID}/revoke`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.equal(response.body.error.message, `no actor ${UNKNOWN_ACTOR_ID}`);
  });
});
