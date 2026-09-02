import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { proposalStatements, readRouteMatrix } from "./proposal.ts";
import {
  objectiveBusy,
  subtreeExclusion,
} from "../../src/domain/run-exclusion.ts";
import { claimRefusalCodes } from "../../src/commands/node/claim-node.ts";

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

  it("the phase-2 file table and the phase-2 directory agree", () => {
    const directory = resolve(
      import.meta.dirname,
      "../../docs/proposal/phase-2",
    );
    const readme = readFileSync(resolve(directory, "README.md"), "utf8");
    const filesSection = readme.split(/^## Files$/m)[1]?.split(/^## /m)[0];
    assert.ok(filesSection);
    const linkedFiles = [
      ...filesSection.matchAll(/^\| \[([^\]]+)\]\(([^)]+)\)/gm),
    ].map((match) => match[2]!);
    const actualFiles = readdirSync(directory)
      .filter((name) => name.endsWith(".md"))
      .filter((name) => name !== "README.md")
      .sort();

    assert.deepEqual(
      linkedFiles.map((file) => file.replace(/^.*\//, "")).sort(),
      actualFiles,
    );
    for (const file of linkedFiles) {
      assert.equal(existsSync(resolve(directory, file)), true, file);
    }
  });

  it("runs-and-exclusion.md declares no route table", () => {
    const phase2File = resolve(
      import.meta.dirname,
      "../../docs/proposal/phase-2/runs-and-exclusion.md",
    );
    const apiFile = resolve(
      import.meta.dirname,
      "../../docs/proposal/api/runs-and-exclusion.md",
    );

    assert.equal(existsSync(phase2File), true);
    assert.equal(existsSync(apiFile), false);
    assert.equal(
      readRouteMatrix().filter(
        (row) => row.status === "routed" || row.status === "stubbed",
      ).length,
      73,
    );
  });

  it("the run model document names both exclusion refusal codes", () => {
    const document = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-2/runs-and-exclusion.md",
      ),
      "utf8",
    );
    const now = 100;
    const subtree = subtreeExclusion({
      targetId: "node-target",
      ancestorIds: ["node-ancestor"],
      descendantIds: [],
      runs: [
        {
          runId: "run-ancestor",
          nodeId: "node-ancestor",
          state: "active",
          expiresAt: now + 1,
        },
      ],
      now,
    });
    const objective = objectiveBusy({
      objectiveId: "objective-1",
      siblingRuns: [
        {
          runId: "run-sibling",
          nodeId: "node-sibling",
          state: "active",
          expiresAt: now + 1,
        },
      ],
      now,
    });

    assert.equal(subtree?.refusal, "subtree-busy");
    assert.equal(objective?.refusal, "objective-busy");
    assert.ok(document.includes(subtree!.refusal));
    assert.ok(document.includes(objective!.refusal));
  });

  it("the run model document names every ordered claim refusal", () => {
    const document = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-2/runs-and-exclusion.md",
      ),
      "utf8",
    );

    assert.equal(claimRefusalCodes.length, 12);
    for (const refusal of claimRefusalCodes) {
      assert.ok(document.includes(refusal), refusal);
    }
  });

  it("the claim sections state the order and the one-path rule", () => {
    const document = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-2/runs-and-exclusion.md",
      ),
      "utf8",
    );

    assert.ok(document.includes("## The refusal order is fixed"));
    assert.ok(document.includes("## The claim has one path"));
    assert.ok(
      document.indexOf("node-not-found") <
        document.indexOf("ancestor-not-startable"),
    );
  });
});
