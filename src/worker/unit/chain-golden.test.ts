import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { evaluationChain } from "./chain-evaluation.ts";
import { examineChain } from "./chain-examine.ts";
import { implementChain } from "./chain-implement.ts";
import { printChain } from "./chain-print.ts";
import { tasksPrepareChain } from "./chain-tasks-prepare.ts";

test("each built chain prints the steps of the golden file in their order", () => {
  const printed = [
    implementChain(),
    evaluationChain(),
    examineChain(),
    tasksPrepareChain(new Set()),
  ]
    .map(printChain)
    .join("\n\n");
  assert.equal(
    `${printed}\n`,
    readFileSync(new URL("./chain-golden.txt", import.meta.url), "utf8"),
  );
});
