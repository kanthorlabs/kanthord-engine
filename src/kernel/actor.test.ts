import assert from "node:assert/strict";
import { test } from "node:test";
import { humanActorSchema } from "./actor.ts";

test("humanActorSchema parses the human variant only", () => {
  const actor = { kind: "human", account: "ulrich", name: "Ulrich" };
  assert.deepEqual(humanActorSchema.parse(actor), actor);
  assert.equal(
    humanActorSchema.safeParse({ ...actor, kind: "service" }).success,
    false,
  );
  assert.equal(
    humanActorSchema.safeParse({ ...actor, extra: 1 }).success,
    false,
  );
});
