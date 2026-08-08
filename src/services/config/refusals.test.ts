import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isLoopback, assertStartable } from "./refusals.ts";
import type { StartableInput } from "./refusals.ts";
import { ConfigError } from "./index.ts";

function validInput(overrides?: Partial<StartableInput>): StartableInput {
  const token = overrides?.token ?? "";
  return {
    masterKey: Buffer.alloc(32).toString("base64"),
    masterKeyFile: "",
    masterKeyFileMode: undefined,
    bind: "127.0.0.1",
    token,
    tokenFile: "",
    tokenFileMode: undefined,
    allowedOrigins: [],
    // `resolvedToken` defaults to mirror `token` so every pre-existing case
    // above keeps behaving exactly as it does today; a case that needs the
    // resolved value to diverge from the configured `token`/`tokenFile`
    // pair (an empty-content tokenFile, in particular) overrides it
    // explicitly.
    resolvedToken: token,
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

    it("http.token and http.tokenFile both set throws config-refused", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              masterKey: "",
              masterKeyFile: "/some/path",
              masterKeyFileMode: 0o600,
              token: "t",
              tokenFile: "/x",
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.code, "config-refused");
          assert.equal(
            err.message,
            "http.token and http.tokenFile are both set; configure exactly one",
          );
          return true;
        },
      );
    });

    it("http.tokenFile mode 0o644 throws config-refused, message ends with found 0644", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              masterKey: "",
              masterKeyFile: "/some/path",
              masterKeyFileMode: 0o600,
              tokenFile: "/x",
              tokenFileMode: 0o644,
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.code, "config-refused");
          assert.equal(
            err.message,
            "http.tokenFile must have mode 0600; found 0644",
          );
          return true;
        },
      );
    });

    it("http.tokenFile mode 0o600 returns undefined", () => {
      const result = assertStartable(
        validInput({ tokenFile: "/x", tokenFileMode: 0o600 }),
      );
      assert.equal(result, undefined);
    });

    it("empty token and empty tokenFile on a loopback bind returns undefined", () => {
      const result = assertStartable(
        validInput({ token: "", tokenFile: "", bind: "127.0.0.1" }),
      );
      assert.equal(result, undefined);
    });

    it("empty token and empty tokenFile on a non-loopback bind still throws the non-loopback message", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({ token: "", tokenFile: "", bind: "203.0.113.1" }),
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

    it("a masterKey refusal fires before a token refusal when both are violated", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              masterKey: "",
              masterKeyFile: "",
              token: "t",
              tokenFile: "/x",
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

    it("rule 5: non-empty allowedOrigins with empty token throws config-refused naming http.token", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              allowedOrigins: ["http://localhost:8080"],
              token: "",
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.code, "config-refused");
          assert.equal(
            err.message,
            "a non-empty http.allowedOrigins requires http.token",
          );
          return true;
        },
      );
    });

    it("returns undefined when allowedOrigins is non-empty and token is non-empty", () => {
      const result = assertStartable(
        validInput({
          allowedOrigins: ["http://localhost:8080"],
          token: "t",
        }),
      );
      assert.equal(result, undefined);
    });

    it("returns undefined when allowedOrigins is empty and token is empty, on a loopback bind", () => {
      const result = assertStartable(
        validInput({ allowedOrigins: [], token: "" }),
      );
      assert.equal(result, undefined);
    });

    it("rule 5 fires on a loopback bind", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              bind: "127.0.0.1",
              allowedOrigins: ["http://localhost:8080"],
              token: "",
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.code, "config-refused");
          return true;
        },
      );
    });

    it("SECURITY: a tokenFile path set but resolving to an empty token still throws the non-loopback message", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              tokenFile: "/run/secrets/kanthord-token",
              tokenFileMode: 0o600,
              resolvedToken: "",
              bind: "0.0.0.0",
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

    it("SECURITY: a tokenFile path set but resolving to an empty token still throws for a non-empty allowedOrigins", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              tokenFile: "/run/secrets/kanthord-token",
              tokenFileMode: 0o600,
              resolvedToken: "",
              allowedOrigins: ["http://a.test"],
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.code, "config-refused");
          assert.equal(
            err.message,
            "a non-empty http.allowedOrigins requires http.token",
          );
          return true;
        },
      );
    });

    it("a tokenFile path set that resolves to a non-empty token satisfies the non-loopback guard", () => {
      const result = assertStartable(
        validInput({
          tokenFile: "/run/secrets/kanthord-token",
          tokenFileMode: 0o600,
          resolvedToken: "s3cret",
          bind: "0.0.0.0",
        }),
      );
      assert.equal(result, undefined);
    });

    it("http.token and http.tokenFile both configured still throws mutual exclusion even when resolvedToken is empty", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              token: "t",
              tokenFile: "/x",
              resolvedToken: "",
            }),
          ),
        (err: unknown) => {
          assert.ok(err instanceof ConfigError);
          assert.equal(err.code, "config-refused");
          assert.equal(
            err.message,
            "http.token and http.tokenFile are both set; configure exactly one",
          );
          return true;
        },
      );
    });

    it("rule order: input failing rules 4 and 5 together reports rule 4", () => {
      assert.throws(
        () =>
          assertStartable(
            validInput({
              masterKey: "",
              masterKeyFile: "/some/path",
              masterKeyFileMode: 0o600,
              bind: "0.0.0.0",
              token: "",
              allowedOrigins: ["http://a.test"],
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
  });
});
