import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findWriterDefects,
  formatFindings,
  listSourceFiles,
  readMigratedSchema,
  resolveConcatenatedConstants,
  systemSchemaWritersDependencies,
  type Column,
  type Schema,
  type SchemaWritersDependencies,
} from "./verify-schema-writers.ts";

const column = (name: string, notNull = false, hasDefault = false): Column => ({
  name,
  notNull,
  hasDefault,
});

// The `run` table as migration 12 shapes it. EPIC 050 authored this migration
// while `openRun` still wrote the shape migration 7 left.
const RUN_AFTER_MIGRATION_12: readonly Column[] = [
  column("id", true),
  column("kind", true),
  column("node_id", true),
  column("driver", true),
  column("workspace_id"),
  column("worker", true),
  column("fence", true),
  column("attempt_limit", true),
  column("head_oid"),
  column("judged_oid"),
  column("graph_revision"),
  column("agents_json", true),
  column("expires_at", true),
  column("max_lifetime_at", true),
  column("state", true),
  column("outcome"),
  column("ended_at"),
];

// `src/services/execution/sqlite.ts` openRun, verbatim, before EPIC 050.1
// rewrote it.
const OPEN_RUN_BEFORE_THE_REWRITE = `
  transaction.run(
    \`INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at)
VALUES (?, ?, ?, ?, 'external', NULL, NULL, ?, ?, NULL, NULL, 'active', NULL, NULL)\`,
  );
`;

function harness(
  schema: Schema,
  sources: Readonly<Record<string, string>>,
): SchemaWritersDependencies {
  return {
    sourceRoot: "src",
    readSchema: () => schema,
    readFile: (path) => sources[path] ?? "",
    listSources: () => Object.keys(sources),
  };
}

describe("scripts/verify-schema-writers.test", () => {
  it("catches the EPIC 050 collision between migration 12 and openRun", () => {
    const findings = findWriterDefects(
      harness(new Map([["run", RUN_AFTER_MIGRATION_12]]), {
        "src/services/execution/sqlite.ts": OPEN_RUN_BEFORE_THE_REWRITE,
      }),
    );

    const of = (rule: string) =>
      findings
        .filter((finding) => finding.rule === rule)
        .map((finding) => finding.column)
        .sort();

    assert.deepEqual(of("unknown-column"), [
      "base_oid",
      "lease_fence",
      "parent_run_id",
    ]);
    assert.deepEqual(of("omitted-not-null"), [
      "agents_json",
      "expires_at",
      "fence",
      "max_lifetime_at",
    ]);
    assert.deepEqual(of("null-into-not-null"), ["worker"]);
    assert.equal(findings.length, 8);
  });

  it("passes the same writer once it is rewritten for the new shape", () => {
    const findings = findWriterDefects(
      harness(new Map([["run", RUN_AFTER_MIGRATION_12]]), {
        "src/services/execution/sqlite.ts": `
          \`INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at)
VALUES (?, ?, ?, 'external', ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'active', NULL, NULL)\`
        `,
      }),
    );

    assert.deepEqual(findings, []);
  });

  it("a NOT NULL column carrying a default may be omitted", () => {
    const findings = findWriterDefects(
      harness(new Map([["t", [column("id", true), column("n", true, true)]]]), {
        "src/a.ts": `\`INSERT INTO t (id) VALUES (?)\``,
      }),
    );

    assert.deepEqual(findings, []);
  });

  it("reports an UPDATE that assigns a column the table does not hold", () => {
    const findings = findWriterDefects(
      harness(new Map([["lease", [column("id", true), column("owner")]]]), {
        "src/services/lease/sqlite.ts": `\`UPDATE lease SET owner = ?, fence = ? WHERE id = ?\``,
      }),
    );

    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.column]),
      [["unknown-column", "fence"]],
    );
  });

  it("reports an upsert whose DO UPDATE SET names a dropped column", () => {
    const findings = findWriterDefects(
      harness(new Map([["t", [column("id", true), column("a")]]]), {
        "src/a.ts": `\`INSERT INTO t (id, a) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET a = excluded.a, gone = excluded.gone\``,
      }),
    );

    assert.deepEqual(
      findings.map((finding) => finding.column),
      ["gone"],
    );
  });

  it("reports a write to a table the schema does not hold", () => {
    const findings = findWriterDefects(
      harness(new Map([["t", [column("id", true)]]]), {
        "src/a.ts": `\`INSERT INTO ghost (id) VALUES (?)\``,
      }),
    );

    assert.deepEqual(
      findings.map((finding) => [finding.rule, finding.table]),
      [["unknown-table", "ghost"]],
    );
  });

  it("resolves a column list held in a concatenated constant", () => {
    const source = `
const NODE_COLUMNS =
  "id, project_id, kind";

const UPSERT_NODE =
  "INSERT INTO node (" +
  NODE_COLUMNS +
  ") VALUES (?, ?, ?)";
`;
    const resolved = resolveConcatenatedConstants(source);

    assert.match(resolved, /INSERT INTO node \(id, project_id, kind\)/);
  });

  it("the shipped writers agree with the migrated schema", () => {
    const findings = findWriterDefects(systemSchemaWritersDependencies);

    assert.deepEqual(findings, [], formatFindings(findings));
  });

  it("every shipped writer file is reachable from the source walk", () => {
    const files = listSourceFiles(systemSchemaWritersDependencies.sourceRoot);

    assert.ok(
      files.some((file) => file.endsWith("services/execution/sqlite.ts")),
      "execution writer not walked",
    );
    assert.equal(
      files.filter((file) => file.endsWith(".test.ts")).length,
      0,
      "test files must not be scanned",
    );
  });

  it("the migrated schema holds every table the writers name", () => {
    const schema = readMigratedSchema();

    assert.ok(schema.has("run"));
    assert.ok(schema.has("node"));
    assert.ok((schema.get("node") ?? []).some((c) => c.name === "assignment"));
  });
});
