import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isLoopback, assertStartable } from "./refusals.ts";
import type { StartableInput } from "./refusals.ts";
import { ConfigError } from "./index.ts";

function validInput(overrides?: Partial<StartableInput>): StartableInput {
  return {
    masterKey: Buffer.alloc(32).toString("base64"),
    masterKeyFile: "",
    masterKeyFileMode: undefined,
    bind: "127.0.0.1",
    token: "",
    ...overrides,
  };
}

describe("src/services/config/refusals.test", () => {
  describe("isLoopback", () => {
    for (const addr of [
      "127.0.0.1",
      "127.0.0.2",
      "127.1.2.3",
      "127.255.255.255",
      "localhost",
      "::1",
    ]) {
      it(`returns true for "${addr}"`, () => {
        assert.equal(isLoopback(addr), true);
      });
    }

    for (const addr of [
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "10.0.0.1",
      "127.0.0.256",
      "127.0.0",
      "128.0.0.1",
      "",
    ]) {
      it(`returns false for "${addr}"`, () => {
        assert.equal(isLoopback(addr), false);
      });
    }
  });

  describe("assertStartable", () => {
    it("returns undefined for loopback bind with empty token and valid masterKey", () => {
      const result = assertStartable(
        validInput({ bind: "127.0.0.1", token: "" }),
      );
      assert.equal(result, undefined);
    });

    it("returns undefined for non-loopback bind with non-empty token", () => {
      const result = assertStartable(
        validInput({ bind: "0.0.0.0", token: "some-token" }),
      );
      assert.equal(result, undefined);
    });

    it("rule 1: both key fields empty throws config-refused", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({ masterKey: "", masterKeyFile: "", bind: "127.0.0.1" }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.code, "config-refused");
          assert.equal(
            err.message,
            "no master key configured; set masterKey or masterKeyFile",
          );
          return true;
        },
      );
    });

    it("rule 2: both key fields set throws config-refused even when bind is also non-loopback with no token", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              masterKey: Buffer.alloc(32).toString("base64"),
              masterKeyFile: "/some/path",
              bind: "0.0.0.0",
              token: "",
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.code, "config-refused");
          assert.equal(
            err.message,
            "masterKey and masterKeyFile are both set; configure exactly one",
          );
          return true;
        },
      );
    });

    it("rule 3: masterKeyFileMode 0o644 throws config-refused, message ends with found 0644", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              masterKey: "",
              masterKeyFile: "/some/path",
              masterKeyFileMode: 0o644,
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.code, "config-refused");
          assert.match(err.message, /found 0644$/);
          return true;
        },
      );
    });

    it("rule 4: bind 0.0.0.0 with empty token throws config-refused", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              masterKey: "",
              masterKeyFile: "/some/path",
              masterKeyFileMode: 0o600,
              bind: "0.0.0.0",
              token: "",
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.code, "config-refused");
          assert.equal(
            err.message,
            "a non-loopback bind address requires http.token",
          );
          return true;
        },
      );
    });

    it("rule order: input failing rules 1 and 4 reports rule 1", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              masterKey: "",
              masterKeyFile: "",
              bind: "0.0.0.0",
              token: "",
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.code, "config-refused");
          assert.equal(
            err.message,
            "no master key configured; set masterKey or masterKeyFile",
          );
          return true;
        },
      );
    });
  });
});
