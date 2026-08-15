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
import { bootstrapActorId } from "../../../domain/actor.ts";
import { registerActor } from "../../../commands/actor/register-actor.ts";
import { listActors } from "../../../queries/actor/list-actor.ts";
import type { ListActorInput } from "../../../queries/actor/list-actor.ts";
import { listActorHandler } from "./list-actor.ts";

const ACTOR_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_A = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const ACTOR_B = "01HZY8QF3M4N5P6R7S8T9V0W1Z";
const EVENT_B = "01HZY8QF3M4N5P6R7S8T9V0W20";

describe("src/http/server/actor/list-actor.test", () => {
  async function buildApp(t: TestContext) {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secret = new NodeCryptoSecret();
    const ids = createMockIdGenerator({
      ulids: [ACTOR_A, EVENT_A, ACTOR_B, EVENT_B],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
    const app = await createTestApp({
      handlers: {
        "actor.list": listActorHandler({
          listActors: (input: ListActorInput) =>
            listActors({ storage: temporary.storage }, input),
        }),
      },
      resolveActor: () => BOOTSTRAP_ACTOR_FIXTURE,
    });
    const deps = { storage: temporary.storage, secret, ids, events, clock };
    registerActor(deps, {
      name: "worker-a",
      actor: BOOTSTRAP_ACTOR_FIXTURE,
      configuredToken: "test-token",
    });
    registerActor(deps, {
      name: "worker-b",
      actor: BOOTSTRAP_ACTOR_FIXTURE,
      configuredToken: "test-token",
    });
    return { app };
  }

  it("GET /v1/actor answers 200 with the bootstrap row first and the registrations in id order, and no body holds a token key", async (t) => {
    const { app } = await buildApp(t);
    const response = await app.get("/v1/actor");
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.actors.map((actor: { id: string }) => actor.id),
      [bootstrapActorId, `actor_${ACTOR_A}`, `actor_${ACTOR_B}`],
    );
    for (const actor of response.body.actors) {
      assert.equal(Object.keys(actor).includes("token"), false);
    }
  });
});
