import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { canTransition } from "../../domain/transition.ts";
import { lintCase } from "../../../test/helpers/lint.ts";

test("canTransition pins the guard's premise for both targets", () => {
  assert.equal(canTransition("task", "running", "ready"), true);
  assert.equal(canTransition("task", "running", "blocked"), true);
});

test("src/commands/startup/recover-expired-leases.test", async () => {
  const source = fs.readFileSync(
    new URL("./recover-expired-leases.ts", import.meta.url),
    "utf8",
  );
  const rules = await lintCase({
    filePath: "src/commands/startup/recover-expired-leases.ts",
    code: source,
  });
  assert.ok(
    !rules.includes("no-restricted-syntax"),
    "unexpected no-restricted-syntax",
  );
});
