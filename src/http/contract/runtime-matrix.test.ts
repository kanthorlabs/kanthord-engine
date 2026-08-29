import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { registry } from "./registry.ts";

const document = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../docs/proposal/phase-1/runtime-capability-matrix.md",
  ),
  "utf8",
);

const section = document.split("\n## The operation matrix\n")[1];
if (section === undefined) {
  assert.fail("the section `## The operation matrix` is absent");
}

const sectionBody = section.split("\n## ")[0];
if (sectionBody === undefined) {
  assert.fail("the operation matrix section has no body");
}

const lines = sectionBody.split("\n").map((line) => line.trim());
const start = lines.findIndex((line) => line.startsWith("|"));
assert.ok(start !== -1, "the operation table is absent");

let end = start;
while (end < lines.length && lines[end]!.startsWith("|")) end += 1;

const rows = lines.slice(start, end);
assert.ok(rows.length > 2, "the operation table has no data row");

const dataRows = rows.slice(2);
const documented = dataRows.map((row) => {
  const cell = row.split("|")[1];
  if (cell === undefined) {
    assert.fail("the operation row has no first cell");
  }
  return cell.trim().replace(/^`(.*)`$/, "$1");
});

const routed = registry
  .filter((entry) => entry.status === "routed")
  .map((entry) => entry.operationId);

describe("src/http/contract/runtime-matrix.test", () => {
  it("names every routed operation", () => {
    const missing = routed.filter(
      (operationId) => !documented.includes(operationId),
    );
    assert.deepEqual(
      missing,
      [],
      `the matrix is missing: ${missing.join(", ")}`,
    );
  });

  it("names no operation the registry lacks", () => {
    const unknown = documented.filter(
      (operationId) => !routed.includes(operationId),
    );
    assert.deepEqual(
      unknown,
      [],
      `the matrix names unknown operations: ${unknown.join(", ")}`,
    );
  });

  it("documents exactly 45 routed operations", () => {
    assert.equal(documented.length, 45);
    assert.equal(routed.length, 45);
  });

  it("lists the operations in registry order", () => {
    assert.deepEqual(documented, routed);
  });

  it("gives every data row nine cells", () => {
    const widths = dataRows
      .map((row, index) => ({ index, width: row.split("|").length - 2 }))
      .filter(({ width }) => width !== 9);
    assert.deepEqual(
      widths,
      [],
      `data rows with the wrong width: ${widths
        .map(({ index, width }) => `${index}=${width}`)
        .join(", ")}`,
    );
  });
});
