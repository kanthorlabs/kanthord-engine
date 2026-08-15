// One-off check for EPIC 015 Story 9: the field-decisions fixture must equal
// the freshly walked registry. Replicates the fieldRows walker of
// src/http/contract/coverage.test.ts and regenerates the fixture with --write.
// Usage: node scripts/field-decisions-probe.mjs [--write]
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { registry } from "../src/http/contract/registry.ts";
import { fieldDecisions } from "../src/http/contract/field-decisions.fixture.ts";

const write = process.argv.includes("--write");

function fieldRows(label, schema) {
  const rows = [];

  function walk(pointer, node, requiredHere, emit) {
    if (node === null || typeof node !== "object") return;
    const record = node;

    if (emit) {
      const nullable = record.nullable === true;
      const enumVal = record.enum;
      const enumStr = Array.isArray(enumVal) ? enumVal.join(",") : "-";
      rows.push(
        `${pointer} required=${requiredHere} nullable=${nullable} enum=${enumStr}`,
      );
    }

    if (
      record.properties !== null &&
      typeof record.properties === "object" &&
      !Array.isArray(record.properties)
    ) {
      const props = record.properties;
      const required = Array.isArray(record.required) ? record.required : [];
      const keys = Object.keys(props).sort(bytewise);
      for (const key of keys) {
        walk(
          `${pointer}/properties/${key}`,
          props[key],
          required.includes(key),
          true,
        );
      }
    }
    if (record.items !== undefined) {
      walk(`${pointer}/items`, record.items, requiredHere, false);
    }
    if (
      record.additionalProperties !== undefined &&
      typeof record.additionalProperties === "object" &&
      record.additionalProperties !== null
    ) {
      walk(
        `${pointer}/additionalProperties`,
        record.additionalProperties,
        requiredHere,
        false,
      );
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const arr = record[key];
      if (Array.isArray(arr)) {
        arr.forEach((item, index) => {
          walk(`${pointer}/${key}/${index}`, item, requiredHere, false);
        });
      }
    }
  }

  walk(label, schema, false, false);
  return rows;
}

const rows = [];
for (const entry of registry) {
  const slots = [
    ["query", "input"],
    ["request", "input"],
    ["response", "output"],
  ];
  for (const [slot, io] of slots) {
    const schema = entry[slot];
    if (schema === undefined) continue;
    const jsonSchema = z.toJSONSchema(schema, { target: "openapi-3.0", io });
    rows.push(...fieldRows(`${entry.operationId}.${slot}#`, jsonSchema));
  }
}
rows.sort(bytewise);

const fixture = new Set(fieldDecisions);
const missing = rows.filter((row) => !fixture.has(row));
const extra = fieldDecisions.filter(
  (row) => !fixture.has(row) || !rows.includes(row),
);

if (missing.length === 0 && extra.length === 0) {
  console.log(`fixture in sync: ${rows.length} rows`);
  process.exit(0);
}

console.log(`walked ${rows.length} rows, fixture has ${fieldDecisions.length}`);
console.log(`missing from fixture (${missing.length}):`);
for (const row of missing) console.log(`  ${row}`);
console.log(`extra in fixture (${extra.length}):`);
for (const row of extra) console.log(`  ${row}`);

if (write) {
  const content =
    `export const fieldDecisions: readonly string[] = [\n` +
    rows.map((row) => `  "${row}",`).join("\n") +
    `\n];\n`;
  const target = resolve(
    import.meta.dirname,
    "../src/http/contract/field-decisions.fixture.ts",
  );
  writeFileSync(target, content, "utf8");
  console.log(`wrote ${target} (${rows.length} rows)`);
  process.exit(0);
}

process.exit(1);

function bytewise(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
