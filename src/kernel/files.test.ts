import assert from "node:assert/strict";
import fs, { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { Diagnostic } from "./errors.ts";
import { writePrivate } from "./files.ts";
import { temporary } from "./test-support.ts";

const PUBLISH_FAILED = "system.files.publish_failed";
const REMOVAL_FAILED = "EACCES";
const DESTINATION_NAME = "published.txt";
const EXISTING_CONTENT = "existing";
const NEW_CONTENT = "new";

test("writePrivate keeps the publish error when the temporary file removal also fails", (t) => {
  const destination = join(temporary(t), DESTINATION_NAME);
  writeFileSync(destination, EXISTING_CONTENT);
  t.mock.method(fs, "unlinkSync", () => {
    throw Object.assign(new Error(REMOVAL_FAILED), { code: REMOVAL_FAILED });
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.throws(
    () => writePrivate(destination, NEW_CONTENT),
    (error) => error instanceof Diagnostic && error.code === PUBLISH_FAILED,
  );
});
