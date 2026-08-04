import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertMigrated, StartupError } from "./migration-gate.ts";
import { ConfigError } from "../../services/config/index.ts";
import { HomeLockError } from "../../services/home-lock/index.ts";

describe("src/http/server/migration-gate.test", () => {
  it("returns undefined when nothing is pending", () => {
    assert.equal(assertMigrated({ home: "/h", pending: [] }), undefined);
  });

  it("throws a StartupError with the db-migration-pending code and the exact message", () => {
    try {
      assertMigrated({
        home: "/h",
        pending: [{ version: 2, name: "0002-graph-and-plan" }],
      });
      assert.fail("assertMigrated must throw when a migration is pending");
    } catch (error) {
      assert.ok(error instanceof StartupError);
      assert.equal(error.code, "db-migration-pending");
      assert.equal(error.name, "StartupError");
      assert.equal(
        error.message,
        "the daemon home /h has unapplied migrations 0002-graph-and-plan; run kanthord db migrate",
      );
    }
  });

  it("names the pending migrations in version order, never input order", () => {
    try {
      assertMigrated({
        home: "/h",
        pending: [
          { version: 3, name: "0003-execution-and-journal" },
          { version: 2, name: "0002-graph-and-plan" },
        ],
      });
      assert.fail("assertMigrated must throw when a migration is pending");
    } catch (error) {
      assert.ok(error instanceof StartupError);
      assert.ok(
        error.message.includes(
          "0002-graph-and-plan, 0003-execution-and-journal",
        ),
      );
    }
  });

  it("names kanthord db migrate in the refusal message", () => {
    try {
      assertMigrated({
        home: "/h",
        pending: [{ version: 2, name: "0002-graph-and-plan" }],
      });
      assert.fail("assertMigrated must throw when a migration is pending");
    } catch (error) {
      assert.ok(error instanceof StartupError);
      assert.ok(error.message.includes("kanthord db migrate"));
    }
  });

  it("StartupError is neither a ConfigError nor a HomeLockError", () => {
    const error = new StartupError("db-migration-pending", "message");
    assert.ok(!(error instanceof ConfigError));
    assert.ok(!(error instanceof HomeLockError));
  });
});
