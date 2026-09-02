import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createTemporaryDatabase } from "../test/helpers/database.ts";
import { createMockClock } from "../test/helpers/clock.ts";
import { SqliteStorage } from "../src/services/storage/sqlite.ts";
import { migrations } from "../src/services/storage/migrations.ts";

export type Column = Readonly<{
  name: string;
  notNull: boolean;
  hasDefault: boolean;
}>;

export type Statement = Readonly<{ sql: string; file: string; line: number }>;

export type Finding = Readonly<{
  rule:
    | "unsupported-write"
    | "invalid-statement"
    | "omitted-not-null"
    | "null-into-not-null";
  detail: string;
  file: string;
  line: number;
}>;

export type Report = Readonly<{
  statements: readonly Statement[];
  findings: readonly Finding[];
}>;

export type Checker = Readonly<{
  prepare: (sql: string) => void;
  columnsOf: (table: string) => readonly Column[] | undefined;
  close: () => void;
}>;

export type SchemaWritersDependencies = Readonly<{
  sourceRoot: string;
  openChecker: () => Checker;
  readFile: (path: string) => string;
  listSources: (root: string) => readonly string[];
}>;

const CONSTANT =
  /^const\s+([A-Z_][A-Z0-9_]*)\s*=\s*\n?\s*"((?:[^"\\]|\\.)*)";/gm;
/**
 * SQL shape, not an English verb. `.description("update a node")` is prose, and
 * a write always names its target with `INTO`, `SET` or `FROM`.
 */
const WRITE =
  /^\s*(?:(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s|UPDATE\s+[a-z_]+\s+SET\s|DELETE\s+FROM\s)/i;
const INSERT_TABLE =
  /^\s*(?:INSERT|REPLACE)\s+(?:OR\s+\w+\s+)?INTO\s+([a-z_]+)/i;

/**
 * Opens the migrated schema twice: `SqliteStorage` applies the migrations, and
 * `node:sqlite` reopens the same file so every statement can be compiled by
 * SQLite itself. Compilation is what proves a table, a column, a conflict
 * target and an arity, in every clause and not only in an assignment target.
 */
export function openMigratedChecker(): Checker {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000 }),
    migrations,
  });
  storage.migrate();
  storage.close();

  const database = new DatabaseSync(temporary.path);
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
    close: () => {
      database.close();
      temporary.dispose();
    },
  };
}

export function listSourceFiles(root: string): readonly string[] {
  return readdirSync(root)
    .sort()
    .flatMap((name) => {
      const path = join(root, name);
      if (statSync(path).isDirectory()) return listSourceFiles(path);
      if (!path.endsWith(".ts")) return [];
      if (path.endsWith(".test.ts")) return [];
      if (name.startsWith("migration-")) return [];
      return [path];
    });
}

/** A statement quoted inside a comment is text, not a write. */
export function stripComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, (block) => block.replaceAll(/[^\n]/g, " "))
    .replaceAll(/(^|[^:"'`\\])\/\/[^\n]*/g, (line, lead: string) =>
      lead.concat(" ".repeat(line.length - lead.length)),
    );
}

/**
 * Splices a module-level string constant into the statements that name it, in
 * both shapes this repository uses: `"… (" + NODE_COLUMNS + ") VALUES"` and
 * `` `… RETURNING ${RUN_COLUMNS}` ``. What survives unresolved is reported as
 * `unsupported-write`, so a statement is never skipped for being dynamic.
 */
export function resolveConcatenatedConstants(source: string): string {
  let resolved = source;
  for (const match of source.matchAll(CONSTANT)) {
    const [, name, value] = match;
    resolved = resolved
      .replaceAll(
        new RegExp(`"\\s*\\+\\s*${name}\\s*\\+\\s*"`, "g"),
        value ?? "",
      )
      .replaceAll(`\${${name}}`, value ?? "");
  }
  return resolved;
}

/** Every string, template and single-quoted literal, with its 1-based line. */
export function extractLiterals(source: string): readonly Statement[] {
  const literals: Statement[] = [];
  let index = 0;
  let line = 1;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (character === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (character !== '"' && character !== "'" && character !== "`") {
      index += 1;
      continue;
    }
    const opened = line;
    let cursor = index + 1;
    let text = "";
    while (cursor < source.length && source[cursor] !== character) {
      if (source[cursor] === "\\") {
        text += source[cursor + 1] ?? "";
        cursor += 2;
        continue;
      }
      if (source[cursor] === "\n") line += 1;
      text += source[cursor];
      cursor += 1;
    }
    literals.push({ sql: text, file: "", line: opened });
    index = cursor + 1;
  }
  return literals;
}

/** The balanced group that opens at or after `from`, contents only. */
function balanced(sql: string, from: number): string | undefined {
  const open = sql.indexOf("(", from);
  if (open === -1) return undefined;
  let depth = 0;
  let quote = "";
  for (let cursor = open; cursor < sql.length; cursor += 1) {
    const character = sql[cursor] ?? "";
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(open + 1, cursor);
    }
  }
  return undefined;
}

/** Splits on top-level commas only, so `json_object('k', ?)` stays one entry. */
export function splitTopLevel(clause: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const character of clause) {
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * The two rules SQLite cannot decide at compile time. Both are legal SQL that
 * fails only when the statement runs, so they need the schema, not the parser.
 */
function checkInsertNulls(
  columns: readonly Column[],
  statement: Statement,
): readonly Finding[] {
  const columnClause = balanced(statement.sql, 0);
  const valuesAt = statement.sql.search(/\bVALUES\b/i);
  if (columnClause === undefined || valuesAt === -1) return [];
  const valueClause = balanced(statement.sql, valuesAt);
  if (valueClause === undefined) return [];

  const written = splitTopLevel(columnClause).map((name) => name.trim());
  const values = splitTopLevel(valueClause);
  const valueOf = new Map(written.map((name, index) => [name, values[index]]));

  const findings: Finding[] = [];
  for (const column of columns) {
    if (!column.notNull) continue;
    const value = valueOf.get(column.name);
    if (value === undefined) {
      if (column.hasDefault) continue;
      findings.push({
        rule: "omitted-not-null",
        detail: `${column.name} is NOT NULL with no default and is not written`,
        file: statement.file,
        line: statement.line,
      });
      continue;
    }
    if (value.toUpperCase() === "NULL") {
      findings.push({
        rule: "null-into-not-null",
        detail: `${column.name} is NOT NULL and receives a literal NULL`,
        file: statement.file,
        line: statement.line,
      });
    }
  }
  return findings;
}

export function inspect(dependencies: SchemaWritersDependencies): Report {
  const checker = dependencies.openChecker();
  const statements: Statement[] = [];
  const findings: Finding[] = [];

  try {
    for (const file of dependencies.listSources(dependencies.sourceRoot)) {
      const source = resolveConcatenatedConstants(
        stripComments(dependencies.readFile(file)),
      );
      for (const literal of extractLiterals(source)) {
        if (!WRITE.test(literal.sql)) continue;
        const statement: Statement = { ...literal, file };
        statements.push(statement);

        if (statement.sql.includes("${")) {
          findings.push({
            rule: "unsupported-write",
            detail:
              "the statement is built by interpolation and cannot be checked",
            file,
            line: statement.line,
          });
          continue;
        }
        try {
          checker.prepare(statement.sql);
        } catch (error) {
          findings.push({
            rule: "invalid-statement",
            detail: (error as Error).message,
            file,
            line: statement.line,
          });
          continue;
        }
        const table = INSERT_TABLE.exec(statement.sql)?.[1];
        if (table === undefined) continue;
        const columns = checker.columnsOf(table);
        if (columns) findings.push(...checkInsertNulls(columns, statement));
      }
    }
  } finally {
    checker.close();
  }

  return {
    statements,
    findings: [...findings].sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.rule.localeCompare(right.rule) ||
        left.detail.localeCompare(right.detail),
    ),
  };
}

export function formatFindings(
  findings: readonly Finding[],
  root: string,
): string {
  return findings
    .map(
      (finding) =>
        `${relative(root, finding.file)}:${finding.line} — ${finding.rule} — ${finding.detail}`,
    )
    .join("\n");
}

export const systemSchemaWritersDependencies: SchemaWritersDependencies = {
  sourceRoot: fileURLToPath(new URL("../src", import.meta.url)),
  openChecker: openMigratedChecker,
  readFile: (path) => readFileSync(path, "utf8"),
  listSources: listSourceFiles,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = systemSchemaWritersDependencies.sourceRoot;
  const report = inspect(systemSchemaWritersDependencies);
  if (report.statements.length === 0) {
    // A tree with a database always holds writes, so recognising none means the
    // extractor broke. Refuse rather than report a parity nothing established.
    process.stdout.write("schema-writer parity failed: no write recognised\n");
    process.exit(1);
  }
  if (report.findings.length > 0) {
    process.stdout.write(`${formatFindings(report.findings, root)}\n`);
    process.stdout.write(
      `\nschema-writer parity failed: ${report.findings.length} defects across ${report.statements.length} writes\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `schema-writer parity ok: ${report.statements.length} writes compiled\n`,
  );
}
