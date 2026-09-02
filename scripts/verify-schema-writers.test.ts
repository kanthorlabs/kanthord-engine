import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  extractLiterals,
  formatFindings,
  inspect,
  listSourceFiles,
  resolveConcatenatedConstants,
  splitTopLevel,
  stripComments,
  systemSchemaWritersDependencies,
  type Checker,
  type SchemaWritersDependencies,
} from "./verify-schema-writers.ts";

/** The `run` table exactly as EPIC 050's migration 12 shapes it. */
const RUN_AFTER_MIGRATION_12 = `
CREATE TABLE run (
  id              TEXT NOT NULL PRIMARY KEY,
  kind            TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  driver          TEXT NOT NULL,
  workspace_id    TEXT,
  worker          TEXT NOT NULL,
  fence           INTEGER NOT NULL,
  attempt_limit   INTEGER NOT NULL,
  head_oid        TEXT,
  agents_json     TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  max_lifetime_at INTEGER NOT NULL,
  state           TEXT NOT NULL,
  outcome         TEXT,
  ended_at        INTEGER
)`;

/** `openRun` as it stood before EPIC 050.1 rewrote it. */
const OPEN_RUN_BEFORE_THE_REWRITE = `\`INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at)
VALUES (?, ?, ?, ?, 'external', NULL, NULL, ?, ?, NULL, NULL, 'active', NULL, NULL)\``;

function checkerOver(ddl: readonly string[]): Checker {
  const database = new DatabaseSync(":memory:");
  for (const statement of ddl) database.exec(statement);
  return {
    prepare: (sql) => {
      database.prepare(sql);
    },
    columnsOf: (table) => {
      const known = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .all(table);
      if (known.length === 0) return undefined;
      const info = database
        .prepare(`PRAGMA table_info(${table})`)
        .all() as unknown as readonly Readonly<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>[];
      return info.map((column) => ({
        name: column.name,
        notNull: column.notnull === 1,
        hasDefault: column.dflt_value !== null,
      }));
    },
    close: () => database.close(),
  };
}

function harness(
  ddl: readonly string[],
  sources: Readonly<Record<string, string>>,
): SchemaWritersDependencies {
  return {
    sourceRoot: "src",
    openChecker: () => checkerOver(ddl),
    readFile: (path) => sources[path] ?? "",
    listSources: () => Object.keys(sources).sort(),
  };
}

describe("scripts/verify-schema-writers.test", () => {
  it("catches the EPIC 050 collision between migration 12 and openRun", () => {
    const report = inspect(
      harness([RUN_AFTER_MIGRATION_12], {
        "src/services/execution/sqlite.ts": OPEN_RUN_BEFORE_THE_REWRITE,
      }),
    );

    assert.equal(report.statements.length, 1, "the write must be recognised");
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0]?.rule, "invalid-statement");
    assert.match(report.findings[0]?.detail ?? "", /parent_run_id/);
  });

  it("catches the NOT NULL columns the rewrite must add", () => {
    const report = inspect(
      harness([RUN_AFTER_MIGRATION_12], {
        // The dropped columns are gone, so the statement compiles. What is left
        // is the half SQLite cannot decide until the statement runs.
        "src/a.ts": `\`INSERT INTO run (id, kind, node_id, driver, worker, attempt_limit, state)
VALUES (?, ?, ?, 'external', NULL, ?, 'active')\``,
      }),
    );

    assert.deepEqual(
      report.findings.map((finding) => [finding.rule, finding.detail]),
      [
        [
          "null-into-not-null",
          "worker is NOT NULL and receives a literal NULL",
        ],
        [
          "omitted-not-null",
          "agents_json is NOT NULL with no default and is not written",
        ],
        [
          "omitted-not-null",
          "expires_at is NOT NULL with no default and is not written",
        ],
        [
          "omitted-not-null",
          "fence is NOT NULL with no default and is not written",
        ],
        [
          "omitted-not-null",
          "max_lifetime_at is NOT NULL with no default and is not written",
        ],
      ],
    );
  });

  it("passes the same writer once it is rewritten for the new shape", () => {
    const report = inspect(
      harness([RUN_AFTER_MIGRATION_12], {
        "src/a.ts": `\`INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at)
VALUES (?, ?, ?, 'external', ?, ?, ?, ?, NULL, ?, ?, ?, 'active', NULL, NULL)\``,
      }),
    );

    assert.deepEqual(report.findings, []);
    assert.equal(report.statements.length, 1);
  });

  it("a default permits omission but never a literal NULL", () => {
    const ddl = [
      `CREATE TABLE t (id TEXT NOT NULL, made_at TEXT NOT NULL DEFAULT 'x')`,
    ];

    assert.deepEqual(
      inspect(harness(ddl, { "src/a.ts": `"INSERT INTO t (id) VALUES (?)"` }))
        .findings,
      [],
      "omitting a defaulted column is legal",
    );

    assert.deepEqual(
      inspect(
        harness(ddl, {
          "src/a.ts": `"INSERT INTO t (id, made_at) VALUES (?, NULL)"`,
        }),
      ).findings.map((finding) => finding.rule),
      ["null-into-not-null"],
      "a default does not permit an explicit NULL",
    );
  });

  it("SQLite rejects a dropped column in any clause, not only in a target", () => {
    const ddl = [`CREATE TABLE t (id TEXT NOT NULL, a TEXT)`];
    const cases: Readonly<Record<string, string>> = {
      "src/set.ts": `"UPDATE t SET gone = ? WHERE id = ?"`,
      "src/where.ts": `"UPDATE t SET a = ? WHERE gone = ?"`,
      "src/expression.ts": `"UPDATE t SET a = gone WHERE id = ?"`,
      "src/conflict.ts": `"INSERT INTO t (id) VALUES (?) ON CONFLICT(gone) DO UPDATE SET a = excluded.a"`,
      "src/returning.ts": `"DELETE FROM t WHERE id = ? RETURNING gone"`,
      "src/arity.ts": `"INSERT INTO t (id, a) VALUES (?)"`,
      "src/table.ts": `"INSERT INTO ghost (id) VALUES (?)"`,
    };

    const report = inspect(harness(ddl, cases));

    assert.equal(report.statements.length, Object.keys(cases).length);
    assert.deepEqual(
      report.findings.map((finding) => finding.rule),
      Object.keys(cases).map(() => "invalid-statement"),
    );
  });

  it("an interpolated write is reported, never skipped", () => {
    const report = inspect(
      harness([`CREATE TABLE t (id TEXT NOT NULL)`], {
        "src/a.ts": "`INSERT INTO ${table} (id) VALUES (?)`",
        "src/b.ts": "`UPDATE t SET ${column} = ? WHERE id = ?`",
      }),
    );

    assert.deepEqual(
      report.findings.map((finding) => finding.rule),
      ["unsupported-write", "unsupported-write"],
    );
  });

  it("resolves a column list held in a constant, in both shapes", () => {
    const concatenated = resolveConcatenatedConstants(`
const NODE_COLUMNS =
  "id, project_id, kind";
const UPSERT = "INSERT INTO node (" + NODE_COLUMNS + ") VALUES (?, ?, ?)";
`);
    assert.match(concatenated, /INSERT INTO node \(id, project_id, kind\)/);

    const interpolated = resolveConcatenatedConstants(`
const RUN_COLUMNS =
  "id, kind";
const END = \`UPDATE run SET state = ? RETURNING \${RUN_COLUMNS}\`;
`);
    assert.match(interpolated, /RETURNING id, kind/);
  });

  it("a statement quoted in a comment is text, not a write", () => {
    const report = inspect(
      harness([`CREATE TABLE t (id TEXT NOT NULL)`], {
        "src/a.ts": `
// Historical: UPDATE removed_table SET old_column = ?
/* UPDATE removed_table SET old_column = ? */
const live = "INSERT INTO t (id) VALUES (?)";
`,
      }),
    );

    assert.deepEqual(report.findings, []);
    assert.equal(report.statements.length, 1);
  });

  it("an English description is not mistaken for a write", () => {
    const report = inspect(
      harness([`CREATE TABLE t (id TEXT NOT NULL)`], {
        "src/a.ts": `.description("update a node").description("delete a node")`,
      }),
    );

    assert.deepEqual(report.statements, []);
  });

  it("splits values on top-level commas only", () => {
    assert.deepEqual(splitTopLevel(`?, json_object('k', ?), NULL`), [
      "?",
      "json_object('k', ?)",
      "NULL",
    ]);
  });

  it("reports findings in a stable order", () => {
    const report = inspect(
      harness([`CREATE TABLE t (id TEXT NOT NULL)`], {
        "src/b.ts": `"INSERT INTO t (gone) VALUES (?)"`,
        "src/a.ts": `"INSERT INTO ghost (id) VALUES (?)"`,
      }),
    );

    assert.deepEqual(
      report.findings.map((finding) => finding.file),
      ["src/a.ts", "src/b.ts"],
    );
  });

  it("extracts a literal with its line", () => {
    const literals = extractLiterals('const a = 1;\nconst b = "second line";');

    assert.deepEqual(
      literals.map((literal) => [literal.sql, literal.line]),
      [["second line", 2]],
    );
  });

  it("strips a block comment without moving a line number", () => {
    const stripped = stripComments('/* a\nb */\nconst c = "x";');

    assert.equal(stripped.split("\n").length, 3);
    assert.match(stripped, /const c = "x";/);
  });

  // The inventory is what makes this gate fail closed. Without it, breaking the
  // extractor would make the shipped-tree assertion greener rather than red.
  it("recognises every write the shipped tree holds", () => {
    const report = inspect(systemSchemaWritersDependencies);

    assert.equal(
      report.statements.length,
      52,
      "the recognised write count moved; update it deliberately, never to go green",
    );
    assert.ok(
      report.statements.some((statement) =>
        statement.file.endsWith("services/execution/sqlite.ts"),
      ),
    );
    assert.ok(
      report.statements.some((statement) =>
        statement.file.endsWith("services/plan/sqlite.ts"),
      ),
      "the concatenated node upsert must resolve and be recognised",
    );
  });

  it("every shipped write compiles against the migrated schema", () => {
    const report = inspect(systemSchemaWritersDependencies);

    assert.deepEqual(
      report.findings,
      [],
      formatFindings(
        report.findings,
        systemSchemaWritersDependencies.sourceRoot,
      ),
    );
  });

  it("the source walk is sorted and excludes tests and migrations", () => {
    const files = listSourceFiles(systemSchemaWritersDependencies.sourceRoot);

    assert.deepEqual([...files].sort(), [...files], "walk order is unstable");
    assert.equal(files.filter((file) => file.endsWith(".test.ts")).length, 0);
    assert.equal(
      files.filter((file) => /\/migration-[^/]*$/.test(file)).length,
      0,
      "migrations hold DDL, not application writes",
    );
    assert.ok(
      files.some((file) => file.endsWith("read-migration-status.ts")),
      "a query is not excluded for naming a migration",
    );
  });
});
