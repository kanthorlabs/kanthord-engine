import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJSON } from "./json.ts";
test("ingress rejects duplicate members before JSON.parse drops them, including escaped keys", () => {
  for (const source of [
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"nested":{"a":1,"a":2}}',
    '{"secret-marker":',
    "[1,]",
    "1e999",
    '"\\ud800"',
  ]) {
    assert.throws(
      () => parseJSON(source),
      (error: Error) => {
        assert.doesNotMatch(error.message, /secret-marker/);
        return true;
      },
    );
  }
  assert.deepEqual(parseJSON('{"a":[true,null,1e3,"\\\""]}'), {
    a: [true, null, 1000, '"'],
  });
});
