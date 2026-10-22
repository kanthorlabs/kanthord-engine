import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRows, rowWidth } from "./rows.ts";

const URL = "https://auth.example/device?user_code=ABCD-EFGH";
const NO_OUTPUT = "";
const FIXED_WIDTH = 16;
const FIXED_WIDTH_ROW = "backup:         /a\n";
const ALIGNED_ROWS =
  "session_id:      lls_1\ncount:           0\nidempotency_key: idempotency_key_01K0000000000000000000000A\n";
const REPEATED_ROWS = "backup: /a\nbackup: /b\n";

test("rows align every value to the longest name and omit empty values", () => {
  assert.equal(
    formatRows([
      ["session_id", "lls_1"],
      ["code", null],
      ["note", ""],
      ["missing", undefined],
      ["count", 0],
      ["idempotency_key", "idempotency_key_01K0000000000000000000000A"],
    ]),
    ALIGNED_ROWS,
  );
});

test("a URL block follows the rows after one empty line with the bare URL at column 0", () => {
  assert.equal(
    formatRows([["code", "ABCD-EFGH"]], [["address", URL]]),
    `code: ABCD-EFGH\n\naddress:\n${URL}\n`,
  );
  assert.equal(formatRows([], [["address", URL]]), `address:\n${URL}\n`);
  assert.equal(formatRows([["a", null]], [["address", null]]), NO_OUTPUT);
});

test("repeated names keep their order", () => {
  assert.equal(
    formatRows([
      ["backup", "/a"],
      ["backup", "/b"],
    ]),
    REPEATED_ROWS,
  );
});

test("a fixed width from a closed name set aligns rows that print one at a time", () => {
  const width = rowWidth(["up_to_date", "config_version"]);
  assert.equal(width, FIXED_WIDTH);
  assert.equal(formatRows([["backup", "/a"]], [], width), FIXED_WIDTH_ROW);
});
