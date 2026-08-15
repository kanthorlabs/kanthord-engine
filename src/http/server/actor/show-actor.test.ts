import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  createTestApp,
  BOOTSTRAP_ACTOR_FIXTURE,
} from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../../test/helpers/ids.ts";
import { NodeCryptoSecret } from "../../../services/secret/node-crypto.ts";
import { SqliteEventLog } from "../../../services/event/sqlite.ts";
import { registerActor } from "../../../commands/actor/register-actor.ts";
import { showActor } from "../../../queries/actor/show-actor.ts";
import type { ShowActorInput } from "../../../queries/actor/show-actor.ts";
import { showActorHandler } from "./show-actor.ts";

const ACTOR_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const UNKNOWN_ACTOR_ID = "actor_01HZY8QF3M4N5P6R7S8T9V0W1Z";

describe("src/http/server/actor/show-actor.test", () => {
  async function buildApp(t: TestContext) {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secret = new NodeCryptoSecret();
    const ids = createMockIdGenerator({ ulids: [ACTOR_ULID, EVENT_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const app = await createTestApp({
      handlers: {
        "actor.show": showActorHandler({
          showActor: (input: ShowActorInput) =>
            showActor({ storage: temporary.storage }, input),
        }),
      },
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
    });
    const registered = registerActor(
      { storage: temporary.storage, secret, ids, events, clock },
      {
        name: "worker-a",
        actor: BOOTSTRAP_ACTOR_FIXTURE,
        configuredToken: "test-token",
      },
    );
    return { app, registered };
  }

  it("GET /v1/actor/<known id> answers 200 and the body holds no token key", async (t) => {
    const { app, registered } = await buildApp(t);
    const response = await app.get(`/v1/actor/${registered.view.id}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.id, registered.view.id);
    assert.equal(response.body.kind, "harness");
    assert.equal(Object.keys(response.body).includes("token"), false);
    assert.equal(Object.keys(response.body).includes("tokenSha256"), false);
  });

  it("GET /v1/actor/<unknown> answers 404 with the no actor message", async (t) => {
    const { app } = await buildApp(t);
    const response = await app.get(`/v1/actor/${UNKNOWN_ACTOR_ID}`);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.equal(response.body.error.message, `no actor ${UNKNOWN_ACTOR_ID}`);
  });
});
