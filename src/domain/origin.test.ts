import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canonicalizeOrigin } from "./origin.ts";

const acceptTable: ReadonlyArray<readonly [string, string]> = [
  ["http://a.test", "http://a.test"],
  ["http://localhost:8080", "http://localhost:8080"],
  ["http://LOCALHOST:80", "http://localhost"],
  ["https://a.test:443", "https://a.test"],
  ["http://[::1]:8080", "http://[::1]:8080"],
  ["http://пример.рф", "http://xn--e1afmkfd.xn--p1ai"],
  ["http://xn--e1afmkfd.xn--p1ai", "http://xn--e1afmkfd.xn--p1ai"],
];

const refuseTable: ReadonlyArray<readonly [string, string]> = [
  ["*", "wildcard"],
  ["http://*.test", "wildcard"],
  ["http://*.test/path", "wildcard"],
  ["null", "scheme"],
  ["ftp://a.test", "scheme"],
  ["http:a.test", "scheme"],
  ["http:/a.test", "scheme"],
  ["http://user:pw@a.test", "credentials"],
  ["http://@a.test", "credentials"],
  ["http://:@a.test", "credentials"],
  ["http://a.test/", "path"],
  ["http://a.test/path", "path"],
  ["http://a.test\\path", "path"],
  ["http://a.test?q=1", "query"],
  ["http://a.test?", "query"],
  ["http://a.test?q=/", "query"],
  ["http://a.test#f", "fragment"],
  ["http://a.test#", "fragment"],
  ["http://a.test#/", "fragment"],
  ["  http://a.test", "whitespace"],
  ["http://a.test  ", "whitespace"],
  ["http://", "unparsable"],
  ["https://", "unparsable"],
];

describe("src/domain/origin.test", () => {
  describe("canonicalizeOrigin — accepts and canonicalizes", () => {
    for (const [input, origin] of acceptTable) {
      it(`${JSON.stringify(input)} canonicalizes to ${JSON.stringify(origin)}`, () => {
        const result = canonicalizeOrigin(input);
        assert.equal(result.ok, true);
        assert.equal((result as { ok: true; origin: string }).origin, origin);
      });
    }
  });

  describe("canonicalizeOrigin — refuses with a reason", () => {
    for (const [input, reason] of refuseTable) {
      it(`${JSON.stringify(input)} is refused as ${reason}`, () => {
        const result = canonicalizeOrigin(input);
        assert.equal(result.ok, false);
        assert.equal((result as { ok: false; reason: string }).reason, reason);
      });
    }
  });
});
