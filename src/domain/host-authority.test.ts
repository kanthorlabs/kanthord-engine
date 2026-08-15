import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  wildcardBinds,
  isWildcardBind,
  deriveAllowedHosts,
} from "./host-authority.ts";

describe("src/domain/host-authority.test", () => {
  describe("wildcardBinds", () => {
    it("holds exactly the two wildcard binds", () => {
      assert.deepEqual([...wildcardBinds], ["0.0.0.0", "::"]);
    });
  });

  describe("isWildcardBind", () => {
    it("returns true for exactly the two wildcard binds", () => {
      for (const bind of wildcardBinds) {
        assert.equal(isWildcardBind(bind), true);
      }
    });

    it("returns false for loopback binds, a concrete address and the empty string", () => {
      for (const bind of ["127.0.0.1", "localhost", "::1", "10.1.2.3", ""]) {
        assert.equal(isWildcardBind(bind), false);
      }
    });
  });

  describe("deriveAllowedHosts", () => {
    for (const [bind, expected] of [
      ["127.0.0.1", ["127.0.0.1:31415", "localhost:31415"]],
      ["localhost", ["127.0.0.1:31415", "localhost:31415"]],
      ["::1", ["127.0.0.1:31415", "localhost:31415", "[::1]:31415"]],
      ["10.1.2.3", ["10.1.2.3:31415"]],
      ["fd00::1", ["[fd00::1]:31415"]],
      ["0.0.0.0", []],
      ["::", []],
      ["127.0.0.5", ["127.0.0.1:31415", "localhost:31415"]],
    ] as const) {
      it(`derives ${JSON.stringify(expected)} for bind ${JSON.stringify(bind)} at port 31415`, () => {
        assert.deepEqual(deriveAllowedHosts({ bind, port: 31415 }), [
          ...expected,
        ]);
      });
    }

    it("two successive calls on one input return deep-equal lists", () => {
      const first = deriveAllowedHosts({ bind: "127.0.0.1", port: 31415 });
      const second = deriveAllowedHosts({ bind: "127.0.0.1", port: 31415 });
      assert.deepEqual(first, second);
    });
  });
});
