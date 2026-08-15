import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NodeCryptoSecret } from "../../services/secret/node-crypto.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import { bootstrapActorId } from "../../domain/actor.ts";
import { BOOTSTRAP_ACTOR_FIXTURE } from "../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { registerActor } from "../../commands/actor/register-actor.ts";
import { revokeActor } from "../../commands/actor/revoke-actor.ts";
import { listActors } from "./list-actor.ts";

const ACTOR_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_A = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const ACTOR_B = "01HZY8QF3M4N5P6R7S8T9V0W1Z";
const EVENT_B = "01HZY8QF3M4N5P6R7S8T9V0W20";
const ACTOR_C = "01HZY8QF3M4N5P6R7S8T9V0W21";
const EVENT_C = "01HZY8QF3M4N5P6R7S8T9V0W22";
const REVOKE_EVENT = "01HZY8QF3M4N5P6R7S8T9V0W23";

describe("src/queries/actor/list-actor.test", () => {
  it("returns the bootstrap row first and then every registration in ascending bytewise id order", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secret = new NodeCryptoSecret();
    const ids: IdGenerator = createMockIdGenerator({
      ulids: [
        ACTOR_A,
        EVENT_A,
        ACTOR_B,
        EVENT_B,
        ACTOR_C,
        EVENT_C,
        REVOKE_EVENT,
      ],
    });
    const clock: Clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
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
    registerActor(deps, {
      name: "worker-c",
      actor: BOOTSTRAP_ACTOR_FIXTURE,
      configuredToken: "test-token",
    });

    const views = listActors({ storage: temporary.storage }, {});
    assert.deepEqual(
      views.map((view) => view.id),
      [
        bootstrapActorId,
        `actor_${ACTOR_A}`,
        `actor_${ACTOR_B}`,
        `actor_${ACTOR_C}`,
      ],
    );
    assert.deepEqual(views[0], {
      id: bootstrapActorId,
      kind: "human",
      name: "bootstrap",
      registeredBy: null,
      createdAt: 0,
      revokedAt: null,
      revokedBy: null,
    });
    assert.equal(views[1]!.name, "worker-a");
    assert.equal(views[2]!.name, "worker-b");
    assert.equal(views[3]!.name, "worker-c");
  });

  it("a revoked row is listed and its view carries a non-null revokedAt", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secret = new NodeCryptoSecret();
    const ids: IdGenerator = createMockIdGenerator({
      ulids: [
        ACTOR_A,
        EVENT_A,
        ACTOR_B,
        EVENT_B,
        ACTOR_C,
        EVENT_C,
        REVOKE_EVENT,
      ],
    });
    const clock: Clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });
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
    registerActor(deps, {
      name: "worker-c",
      actor: BOOTSTRAP_ACTOR_FIXTURE,
      configuredToken: "test-token",
    });
    revokeActor(
      { storage: temporary.storage, events, clock },
      { id: `actor_${ACTOR_B}`, actor: BOOTSTRAP_ACTOR_FIXTURE },
    );

    const views = listActors({ storage: temporary.storage }, {});
    assert.deepEqual(
      views.map((view) => view.id),
      [
        bootstrapActorId,
        `actor_${ACTOR_A}`,
        `actor_${ACTOR_B}`,
        `actor_${ACTOR_C}`,
      ],
    );
    const revoked = views.find((view) => view.id === `actor_${ACTOR_B}`);
    assert.notEqual(revoked, undefined);
    assert.equal(revoked!.revokedAt, 1700000003000);
    assert.equal(revoked!.revokedBy, bootstrapActorId);
  });
});
