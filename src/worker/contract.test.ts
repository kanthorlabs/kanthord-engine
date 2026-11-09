import assert from "node:assert/strict";
import { test } from "node:test";
import { instanceNameSchema } from "./contract.ts";

test("each static route segment of the instance exchange is a reserved instance name", () => {
  for (const name of ["server", "token", "connect", "heartbeat", "work"])
    assert.equal(instanceNameSchema.safeParse(name).success, false);
  assert.equal(instanceNameSchema.safeParse("worker").success, true);
});
