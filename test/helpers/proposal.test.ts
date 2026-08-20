import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { proposalStatements } from "./proposal.ts";

const tables = [
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
];

describe("test/helpers/proposal.test", () => {
  it("blob yields one comment-free normalized statement", () => {
    assert.deepEqual(proposalStatements("blob"), [
      "CREATE TABLE blob ( hash TEXT PRIMARY KEY, size INTEGER NOT NULL, content BLOB NOT NULL, created_at INTEGER NOT NULL ) STRICT",
    ]);
  });

  it("run yields the table and the unique index as two statements in order", () => {
    assert.deepEqual(proposalStatements("run"), [
      "CREATE TABLE run ( id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('objective', 'task')), node_id TEXT NOT NULL REFERENCES node(id), parent_run_id TEXT REFERENCES run(id), driver TEXT NOT NULL CHECK (driver IN ('internal', 'external')), workspace_id TEXT REFERENCES workspace(id), worker TEXT, lease_fence INTEGER NOT NULL, attempt_limit INTEGER NOT NULL, base_oid TEXT, head_oid TEXT, state TEXT NOT NULL CHECK (state IN ('active', 'ended')), outcome TEXT, ended_at INTEGER, CHECK ((kind = 'objective') = (parent_run_id IS NULL)), CHECK ((driver = 'internal') = (workspace_id IS NOT NULL)), CHECK ((driver = 'internal') = (worker IS NOT NULL)), CHECK ((driver = 'internal') = (base_oid IS NOT NULL)), UNIQUE (id, driver) ) STRICT",
      "CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active'",
    ]);
  });

  it("every table file yields exactly one statement except run, edge and node, all normalized and comment-free", () => {
    for (const table of tables) {
      const statements = proposalStatements(table);
      const expected =
        table === "run" ? 2 : table === "edge" ? 2 : table === "node" ? 2 : 1;
      assert.equal(statements.length, expected, table);
      for (const statement of statements) {
        assert.ok(statement.length > 0, table);
        assert.equal(statement, statement.replace(/\s+/g, " ").trim(), table);
        assert.ok(!statement.includes("--"), table);
      }
    }
  });

  it("throws a plain Error naming the file when no sql block exists", () => {
    assert.throws(
      () => proposalStatements("README"),
      (error: unknown) =>
        error instanceof Error && error.message === "no sql block in README.md",
    );
  });
});
