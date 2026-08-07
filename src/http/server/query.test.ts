import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readQuery } from "./query.ts";

describe("src/http/server/query.test", () => {
  it("returns an empty object for an empty querystring", () => {
    assert.deepEqual(readQuery(""), {});
  });

  it("maps each key to a single-element list", () => {
    assert.deepEqual(readQuery("type=node.created&limit=10"), {
      type: ["node.created"],
      limit: ["10"],
    });
  });

  it("orders keys bytewise regardless of wire order", () => {
    assert.deepEqual(Object.keys(readQuery("b=2&a=1")), ["a", "b"]);
    assert.deepEqual(Object.keys(readQuery("a=1&b=2")), ["a", "b"]);
  });

  it("maps an empty value to a single empty string", () => {
    assert.deepEqual(readQuery("after="), { after: [""] });
  });

  it("percent-decodes a value", () => {
    assert.deepEqual(readQuery("subject=node_01HZ%3Ax"), {
      subject: ["node_01HZ:x"],
    });
  });

  it("preserves every repeated value in wire order and throws nothing", () => {
    assert.deepEqual(readQuery("a=1&a=2"), { a: ["1", "2"] });
  });

  it("never throws for any input in this file", () => {
    assert.doesNotThrow(() => readQuery(""));
    assert.doesNotThrow(() => readQuery("a=1&a=2"));
    assert.doesNotThrow(() => readQuery("after="));
  });
});
