import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NodeCryptoSecret } from "../../services/secret/node-crypto.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { BOOTSTRAP_ACTOR_FIXTURE } from "../../../test/helpers/app.ts";
import { registerActor } from "../../commands/actor/register-actor.ts";
import { showActor } from "./show-actor.ts";

const ACTOR_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";

describe("src/queries/actor/show-actor.test", () => {
  it("a known id returns the view with no token key and no tokenSha256 key", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const secret = new NodeCryptoSecret();
    const ids = createMockIdGenerator({ ulids: [ACTOR_ULID, EVENT_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events = new SqliteEventLog({ storage: temporary.storage, ids });

    const registered = registerActor(
      { storage: temporary.storage, secret, ids, events, clock },
      {
        name: "worker-a",
        actor: BOOTSTRAP_ACTOR_FIXTURE,
        configuredToken: "test-token",
      },
    );

    const view = showActor(
      { storage: temporary.storage },
      { id: registered.view.id },
    );
    assert.notEqual(view, null);
    assert.equal(view!.id, registered.view.id);
    assert.equal(view!.kind, "harness");
    assert.equal(view!.name, "worker-a");
    assert.equal(view!.registeredBy, BOOTSTRAP_ACTOR_FIXTURE.id);
    assert.equal(Object.keys(view!).includes("token"), false);
    assert.equal(Object.keys(view!).includes("tokenSha256"), false);
  });

  it("an unknown id returns null", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());

    const view = showActor(
      { storage: temporary.storage },
      { id: `actor_${EVENT_ULID}` },
    );
    assert.equal(view, null);
  });
});
