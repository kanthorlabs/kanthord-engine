import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { cursorOrders } from "./cursor.ts";

describe("src/domain/cursor.test", () => {
  it("cursorOrders deep-equals asc and desc in order", () => {
    assert.deepEqual(cursorOrders, ["asc", "desc"]);
  });
});
