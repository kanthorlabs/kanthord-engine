import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRows } from "./rows.ts";

const URL = "https://auth.example/device?user_code=ABCD-EFGH";
const NO_OUTPUT = "";
const ALIGNED_ROWS =
  "session_id:      lls_1\ncount:           0\nidempotency_key: 01K0000000000000000000000A\n";
const REPEATED_ROWS = "backup: /a\nbackup: /b\n";

test("rows align every value to the longest name and omit empty values", () => {
  assert.equal(
    formatRows([
      ["session_id", "lls_1"],
      ["code", null],
      ["note", ""],
      ["missing", undefined],
      ["count", 0],
      ["idempotency_key", "01K0000000000000000000000A"],
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
