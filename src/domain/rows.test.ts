import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { rows } from "./rows.ts";
import { profileRow } from "./profile.ts";

describe("src/domain/rows.test", () => {
  it("Object.keys(rows).length equals 20", () => {
    assert.equal(Object.keys(rows).length, 20);
  });

  it("Object.keys(rows) deep-equals the 20 table names sorted lexicographically", () => {
    assert.deepEqual(Object.keys(rows), [
      "actor",
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
      resolve(import.meta.dirname, "../../docs/proposal/phase-1/domain.md"),
      "utf-8",
    );
    for (const key of Object.keys(rows)) {
      assert.ok(
        domainMd.includes(`\`${key}\``),
        `expected domain.md to contain table name \`${key}\``,
      );
    }
  });

  it("the table list of domain.md equals Object.keys(rows)", () => {
    const domainMd = readFileSync(
      resolve(import.meta.dirname, "../../docs/proposal/phase-1/domain.md"),
      "utf-8",
    );
    const lines = domainMd.split("\n");
    const markerIndex = lines.indexOf("`node:sqlite`. Tables:");
    assert.notEqual(
      markerIndex,
      -1,
      "domain.md has no `node:sqlite`. Tables: marker",
    );

    const declarationLine = lines
      .slice(markerIndex + 1)
      .find((line) => line.trim().length > 0);
    assert.ok(
      declarationLine !== undefined,
      "domain.md has no table declaration line",
    );

    const declared = [...declarationLine.matchAll(/`([a-z_]+)`/g)].map(
      (match) => match[1] as string,
    );

    assert.equal(
      new Set(declared).size,
      declared.length,
      "domain.md names a table twice",
    );
    assert.deepEqual([...declared].sort(), Object.keys(rows));
  });
});
