import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPi } from "../agent/pi.ts";
import {
  pidsIn,
  PROCESS_TREE_PIDS,
  processTreeCommand,
  spawnedPids,
  survivingProcesses,
} from "../agent/test-support.ts";
import { temporary } from "../kernel/test-support.ts";
import { builtinTools } from "./tools.ts";

const TIMEOUT_SECONDS = 20;

test("a workbench bash call that times out leaves no process of its tree", async (t) => {
  const [bash] = builtinTools(
    await loadPi(),
    "swe@1",
    temporary(t),
  ).customTools;
  assert.ok(bash);
  let ready = false;
  const failure: Error = await bash
    .execute(
      "call_bash",
      { command: processTreeCommand(), timeout: TIMEOUT_SECONDS },
      undefined,
      (update) => {
        if (pidsIn(update.content).length === PROCESS_TREE_PIDS) ready = true;
      },
      undefined as never,
    )
    .then(
      () => assert.fail("the bash call ended without a kill"),
      (error: Error) => error,
    );
  assert.ok(ready, "the process tree did not start before the timeout");
  const spawned = spawnedPids(t, [{ type: "text", text: failure.message }]);
  assert.match(failure.message, /Command timed out after 20 seconds/);
  assert.equal(spawned.length, PROCESS_TREE_PIDS);
  assert.deepEqual(await survivingProcesses(spawned), []);
});
