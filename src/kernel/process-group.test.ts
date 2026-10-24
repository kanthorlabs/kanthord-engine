import assert from "node:assert/strict";
import { test } from "node:test";
import { procStatRow } from "./process-group.ts";

test("a Linux stat line gives the pid, the parent and the group, also for a name with a space and a parenthesis", () => {
  assert.deepEqual(
    procStatRow("4242 (node (test) run) S 4200 4100 4100 0 -1 4194560 120"),
    { pid: 4242, ppid: 4200, group: 4100 },
  );
});

test("a stat line with no name end is refused", () => {
  assert.throws(() => procStatRow("4242 node S 4200 4100"));
});
