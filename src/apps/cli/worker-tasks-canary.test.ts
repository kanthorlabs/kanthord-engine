import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { hostEnvironment } from "../../kernel/test-support.ts";
import { missionOperations } from "../../mission/contract.ts";
import { HostTool } from "../../worker/contract.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedProvider,
} from "../../worker/unit/test-support.ts";
import { TasksExit } from "../worker/index.ts";
import {
  commandRun,
  CREDENTIAL_CANARY,
  filesOf,
  keysOf,
  OUTPUT_FILES,
  PASS_NAME,
  PASS_VALUE,
  readJson,
  REFUSED_KEYS,
  runOptions,
  seedFixture,
  TEST_TIMEOUT_MS,
  writeGood,
} from "./tasks-test-support.ts";
import { tasksRun } from "./worker-tasks.ts";

const UPLOAD_COUNT = 2;
const PI_FILES = ["auth.json", "settings.json"];

function uploadOf(path: string) {
  return fauxAssistantMessage(fauxToolCall(HostTool.EvidenceUpload, { path }), {
    stopReason: "toolUse",
  });
}

test(
  "the canary values of the credential and of --pass-env reach no output file, no state file and no standard stream",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await seedFixture(t);
    const provider = scriptedProvider([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `echo "$${PASS_NAME}" > evidence.txt; printf %s "$${PASS_NAME}" | base64 > evidence64.txt; cat evidence.txt`,
        }),
        { stopReason: "toolUse" },
      ),
      uploadOf("evidence.txt"),
      uploadOf("evidence64.txt"),
      writeGood(),
      fauxAssistantMessage(`done ${CREDENTIAL_CANARY} ${PASS_VALUE}`),
    ]);
    const run = commandRun(fixture, provider, {
      shellEnv: { ...hostEnvironment(), [PASS_NAME]: PASS_VALUE },
    });
    const output = join(fixture.root, "out");
    const code = await tasksRun(
      fixture.seedFolder,
      runOptions(fixture, { passEnv: [PASS_NAME] }),
      run.io,
    );
    assert.equal(code, TasksExit.Success, run.stderr.join(""));
    const outbox = readJson(output, "outbox.json") as unknown as {
      operation: string;
    }[];
    assert.equal(
      outbox.filter(
        (entry) => entry.operation === missionOperations["evidence.submit"].id,
      ).length,
      UPLOAD_COUNT,
    );
    const uploads = filesOf(join(output, "uploads"));
    assert.equal(uploads.length, UPLOAD_COUNT);
    const passForms = [PASS_VALUE, Buffer.from(PASS_VALUE).toString("base64")];
    const texts = [
      ...[...OUTPUT_FILES.map((name) => join(output, name)), ...uploads].map(
        (file) => [file, readFileSync(file, "utf8")],
      ),
      ["stdout", run.stdout.join("")],
      ["stderr", run.stderr.join("")],
    ];
    for (const canary of [CREDENTIAL_CANARY, ...passForms])
      for (const [name, text] of texts)
        assert.ok(!text!.includes(canary), `${name}: ${canary}`);
    for (const file of filesOf(join(output, "state")))
      assert.ok(
        !readFileSync(file).includes(Buffer.from(CREDENTIAL_CANARY)),
        file,
      );
    for (const name of PI_FILES)
      assert.ok(!existsSync(join(output, "state", "pi", name)), name);
    const keys = keysOf(readJson(output, "context.json"));
    for (const key of REFUSED_KEYS) assert.ok(!keys.includes(key), key);
  },
);
