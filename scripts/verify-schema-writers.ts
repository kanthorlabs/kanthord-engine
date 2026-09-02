import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

export type Schema = ReadonlyMap<string, readonly Column[]>;

export type Finding = Readonly<{
  rule:
    | "unknown-table"
    | "unknown-column"
    | "omitted-not-null"
    | "null-into-not-null";
  table: string;
  column: string;
  file: string;
}>;

export type SchemaWritersDependencies = Readonly<{
  sourceRoot: string;
  readSchema: () => Schema;
  readFile: (path: string) => string;
  listSources: (root: string) => readonly string[];
}>;

const CONSTANT =
  /^const\s+([A-Z_][A-Z0-9_]*)\s*=\s*\n?\s*"((?:[^"\\]|\\.)*)";/gm;
const INSERT =
  /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-z_]+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/gis;
const DO_UPDATE = /^\s*ON\s+CONFLICT[^)]*\)\s*DO\s+UPDATE\s+SET\s+([^;"`]*)/is;
const UPDATE = /(?<!DO\s)UPDATE\s+([a-z_]+)\s+SET\s+([^;"`]*)/gis;

export function readMigratedSchema(): Schema {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000 }),
    migrations,
  });
  try {
    storage.migrate();
    return storage.transact((transaction) => {
      const tables = transaction.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ) as readonly Readonly<{ name: string }>[];
      const schema = new Map<string, readonly Column[]>();
      for (const { name } of tables) {
        const info = transaction.all(
          `PRAGMA table_info(${name})`,
        ) as readonly Readonly<{
          name: string;
          notnull: number;
          dflt_value: string | null;
        }>[];
        schema.set(
          name,
          info.map((column) => ({
            name: column.name,
            notNull: column.notnull === 1,
            hasDefault: column.dflt_value !== null,
          })),
        );
      }
      return schema;
    });
  } finally {
    storage.close();
    temporary.dispose();
  }
}

export function listSourceFiles(root: string): readonly string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    if (!path.endsWith(".ts")) return [];
    if (path.endsWith(".test.ts")) return [];
    if (name.startsWith("migration-")) return [];
    return [path];
  });
}

export function resolveConcatenatedConstants(source: string): string {
  let resolved = source;
  for (const match of source.matchAll(CONSTANT)) {
    const [, name, value] = match;
    resolved = resolved.replaceAll(
      new RegExp(`"\\s*\\+\\s*${name}\\s*\\+\\s*"`, "g"),
      value ?? "",
    );
  }
  return resolved;
}

function names(clause: string): readonly string[] {
  return clause
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(/[\s=]/)[0] ?? "")
    .filter((name) => /^[a-z_]+$/.test(name));
}

function assignedColumns(clause: string): readonly string[] {
  return clause
    .split(/,(?![^()]*\))/)
    .map((entry) => entry.trim().split("=")[0]?.trim() ?? "")
    .filter((name) => /^[a-z_]+$/.test(name));
}

function checkInsert(
  schema: Schema,
  file: string,
  table: string,
  columnClause: string,
  valueClause: string,
): readonly Finding[] {
  const columns = schema.get(table);
  if (!columns) return [{ rule: "unknown-table", table, column: "", file }];

  const findings: Finding[] = [];
  const known = new Set(columns.map((column) => column.name));
  const written = names(columnClause);
  const values = valueClause.split(",").map((value) => value.trim());
  const valueOf = new Map(written.map((name, index) => [name, values[index]]));

  for (const name of written) {
    if (!known.has(name)) {
      findings.push({ rule: "unknown-column", table, column: name, file });
    }
  }
  for (const column of columns) {
    if (!column.notNull || column.hasDefault) continue;
    if (!valueOf.has(column.name)) {
      findings.push({
        rule: "omitted-not-null",
        table,
        column: column.name,
        file,
      });
      continue;
    }
    if ((valueOf.get(column.name) ?? "").toUpperCase() === "NULL") {
      findings.push({
        rule: "null-into-not-null",
        table,
        column: column.name,
        file,
      });
    }
  }
  return findings;
}

function checkAssignments(
  schema: Schema,
  file: string,
  table: string,
  clause: string,
): readonly Finding[] {
  const columns = schema.get(table);
  if (!columns) return [{ rule: "unknown-table", table, column: "", file }];
  const known = new Set(columns.map((column) => column.name));
  return assignedColumns(clause)
    .filter((name) => !known.has(name))
    .map((name) => ({
      rule: "unknown-column" as const,
      table,
      column: name,
      file,
    }));
}

export function findWriterDefects(
  dependencies: SchemaWritersDependencies,
): readonly Finding[] {
  const schema = dependencies.readSchema();
  const findings: Finding[] = [];

  for (const file of dependencies.listSources(dependencies.sourceRoot)) {
    const source = resolveConcatenatedConstants(dependencies.readFile(file));

    for (const match of source.matchAll(INSERT)) {
      const [statement, table, columnClause, valueClause] = match;
      findings.push(
        ...checkInsert(
          schema,
          file,
          table ?? "",
          columnClause ?? "",
          valueClause ?? "",
        ),
      );
      const upsert = DO_UPDATE.exec(
        source.slice((match.index ?? 0) + statement.length),
      );
      if (upsert) {
        findings.push(
          ...checkAssignments(schema, file, table ?? "", upsert[1] ?? ""),
        );
      }
    }

    for (const match of source.matchAll(UPDATE)) {
      const [, table, clause] = match;
      findings.push(
        ...checkAssignments(schema, file, table ?? "", clause ?? ""),
      );
    }
  }
  return findings;
}

const MESSAGE: Readonly<Record<Finding["rule"], string>> = {
  "unknown-table": "writes a table the schema does not hold",
  "unknown-column": "writes a column the table does not hold",
  "omitted-not-null": "omits a NOT NULL column that has no default",
  "null-into-not-null": "writes literal NULL into a NOT NULL column",
};

export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map(
      (finding) =>
        `${finding.table}.${finding.column} — ${MESSAGE[finding.rule]} @ ${finding.file}`,
    )
    .join("\n");
}

export const systemSchemaWritersDependencies: SchemaWritersDependencies = {
  sourceRoot: fileURLToPath(new URL("../src", import.meta.url)),
  readSchema: readMigratedSchema,
  readFile: (path) => readFileSync(path, "utf8"),
  listSources: listSourceFiles,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const findings = findWriterDefects(systemSchemaWritersDependencies);
  if (findings.length > 0) {
    process.stdout.write(`${formatFindings(findings)}\n`);
    process.stdout.write(
      `\nschema-writer parity failed: ${findings.length} defects\n`,
    );
    process.exit(1);
  }
  process.stdout.write("schema-writer parity ok\n");
}
