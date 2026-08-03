import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { rows } from "./rows.ts";
import { profileRow } from "./profile.ts";

describe("src/domain/rows.test", () => {
  it("Object.keys(rows).length equals 19", () => {
    assert.equal(Object.keys(rows).length, 19);
  });

  it("Object.keys(rows) deep-equals the 19 table names sorted lexicographically", () => {
    assert.deepEqual(Object.keys(rows), [
      "agent_invocation",
      "attempt",
      "blob",
      "candidate",
      "check_result",
      "edge",
      "event",
      "git_operation",
      "lease",
      "migration",
      "node",
      "plan_revision",
      "profile",
      "project",
      "project_binding",
      "provider",
      "repository",
      "run",
      "workspace",
    ]);
  });

  it("Object.keys(rows) stays sorted", () => {
    assert.deepEqual(Object.keys(rows), [...Object.keys(rows)].sort());
  });

  it("rows.profile is the same schema reference as profileRow", () => {
    assert.equal(rows.profile, profileRow);
  });

  it("every key of rows appears in domain.md", () => {
    const domainMd = readFileSync(
      resolve(import.meta.dirname!, "../../docs/proposal/phase-1/domain.md"),
      "utf-8",
    );
    for (const key of Object.keys(rows)) {
      assert.ok(
        domainMd.includes(`\`${key}\``),
        `expected domain.md to contain table name \`${key}\``,
      );
    }
  });
});
