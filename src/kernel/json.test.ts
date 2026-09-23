import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJSON, deriveKey, digest } from "./json.ts";

const CANONICAL_NESTED_OBJECT =
  '{"10":10,"2":2,"array":[3,1],"nested":{"a":0,"z":0}}';
const CANONICAL_NUMBERS = "[333333333.3333333,1e+30,4.5,0.002,1e-27]";

test("RFC 8785 canonicalization preserves numeric-name ordering, nested order, arrays and numeric serialization", () => {
  assert.equal(
    canonicalJSON({ "2": 2, "10": 10, nested: { z: 0, a: -0 }, array: [3, 1] }),
    CANONICAL_NESTED_OBJECT,
  );
  assert.equal(
    canonicalJSON([333333333.33333329, 1e30, 4.5, 2e-3, 1e-27]),
    CANONICAL_NUMBERS,
  );
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
  for (const invalid of [
    NaN,
    Infinity,
    undefined,
    "\ud800",
    { ["\udfff"]: 1 },
    Array(1),
    { toJSON: () => 1 },
  ])
    assert.throws(() => canonicalJSON(invalid));
  const key = Buffer.alloc(32).toString("base64");
  assert.notDeepEqual(
    deriveKey(key, "gateway/jwt-hs256/v1"),
    deriveKey(key, "custody/aes-256-gcm/v1"),
  );
});
