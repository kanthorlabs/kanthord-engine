import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AppendEventInput } from "./index.ts";

// Type-level use: the widening of AppendEventInput.actorKind is asserted by
// the module-scope declaration below, so `npm run typecheck` fails if the
// service interface stops accepting "harness".
const harnessAppend: AppendEventInput = {
  subjectKind: "actor",
  subjectId: "actor_01HZY8QF3M4N5P6R7S8T9V0W1X",
  type: "actor.registered",
  actorKind: "harness",
  actorId: "actor_01HZY8QF3M4N5P6R7S8T9V0W1X",
  payload: {},
};

describe("src/services/event/index.test", () => {
  it("AppendEventInput carries the harness actor kind at runtime", () => {
    assert.equal(harnessAppend.actorKind, "harness");
  });

  it("the interface imports the domain enum and declares no second union", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.equal(source.includes('"human" | "daemon"'), false);
    assert.equal(
      source.includes('from "../../domain/event.ts"'),
      true,
      "the interface must import the domain enum",
    );
    assert.equal(
      source.includes("export type ActorKind = EventActorKind"),
      true,
    );
  });
});
