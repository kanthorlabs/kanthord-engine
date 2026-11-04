import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { temporary } from "../kernel/test-support.ts";
import { FootprintKind } from "../footprint/contract.ts";
import { WorkbenchFootprint } from "./footprint.ts";

const WORKBENCH_ITEMS = 4;
const ITEM_BYTES = 1;

test("one item for each session file, each agent cwd and each pi output file; a symlink and another name are skipped", async (t) => {
  const state = temporary(t);
  const temporaryDirectory = temporary(t);
  const sessions = join(state, "pi", "sessions", "workbench", "kanthord");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "one.jsonl"), "x");
  writeFileSync(join(sessions, "two.jsonl"), "x");
  mkdirSync(join(state, "workbench", "kanthord"), { recursive: true });
  writeFileSync(join(state, "workbench", "kanthord", "notes"), "x");
  writeFileSync(join(temporaryDirectory, "pi-bash-0123456789abcdef.log"), "x");
  writeFileSync(join(temporaryDirectory, "other.log"), "x");
  symlinkSync(
    join(temporaryDirectory, "other.log"),
    join(temporaryDirectory, "pi-bash-fedcba9876543210.log"),
  );
  const owner = new WorkbenchFootprint({
    stateDirectory: state,
    temporaryDirectory,
    device: () => Promise.resolve("device"),
  });
  const [workbench] = await owner.measure(AbortSignal.timeout(5000));
  assert.equal(workbench?.kind, FootprintKind.Workbench);
  assert.equal(workbench?.count, WORKBENCH_ITEMS);
  assert.equal(workbench?.bytes, WORKBENCH_ITEMS * ITEM_BYTES);
});
