import assert from "node:assert/strict";
import { test } from "node:test";
import { createProgram } from "./index.ts";

const COUNCIL_COMMAND = "council";
const OUT_OPTION = "--out";

test("council is a top-level command with an idea and a required --out", () => {
  const council = createProgram().commands.find(
    (command) => command.name() === COUNCIL_COMMAND,
  );
  assert.ok(council);
  assert.deepEqual(
    council.registeredArguments.map((argument) => argument.name()),
    ["idea"],
  );
  const out = council.options.find((option) => option.long === OUT_OPTION);
  assert.ok(out?.mandatory);
});
