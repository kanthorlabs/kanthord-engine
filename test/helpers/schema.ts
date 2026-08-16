import assert from "node:assert/strict";

import type { Storage } from "../../src/services/storage/index.ts";

export const tableDdl = (storage: Storage, table: string): string => {
  const row = storage.transact((t) =>
    t.get("SELECT sql FROM sqlite_master WHERE name = ?", [table]),
  ) as { sql: string | null } | undefined;
  assert.ok(row !== undefined && row.sql !== null, `no DDL row for ${table}`);
  return row.sql;
};

export const literalListIn = (
  ddl: string,
  column: string,
): readonly string[] => {
  const pattern = new RegExp(`\\b${column}\\s+IN\\s*\\(([\\s\\S]*?)\\)`);
  const match = ddl.match(pattern);
  assert.ok(match !== null, `no IN clause for ${column} in the DDL`);
  const literals = [...(match[1] ?? "").matchAll(/'([^']*)'/g)].map(
    (item) => item[1] ?? "",
  );
  return literals;
};

export const assertClauseAgrees = (
  storage: Storage,
  table: string,
  column: string,
  domain: readonly string[],
): void => {
  const ddl = tableDdl(storage, table);
  const extracted = literalListIn(ddl, column);
  for (const value of domain) {
    assert.ok(
      ddl.includes(`'${value}'`),
      `${value} is absent from the ${table} DDL`,
    );
  }
  assert.equal(
    extracted.length,
    domain.length,
    `${table}.${column} literal count`,
  );
  assert.deepEqual(extracted, [...domain], `${table}.${column} literal list`);
};
