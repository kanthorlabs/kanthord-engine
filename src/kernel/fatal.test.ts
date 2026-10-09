import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

const ExitCode = { Success: 0, Failure: 1 } as const;

const EMPTY_OUTPUT = "";
const STANDARD_ERROR_DESCRIPTOR = process.stderr.fd;

test("fatal exceptions and rejections terminate without serializing secrets or running cleanup", () => {
  const module = new URL("./fatal.ts", import.meta.url).href;
  for (const event of [
    "throw new Error('secret-marker')",
    "Promise.reject(new Error('secret-marker'))",
    "Promise.reject('secret-marker')",
  ]) {
    for (const fd of [STANDARD_ERROR_DESCRIPTOR, 999999]) {
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { installFatalHandlers } from ${JSON.stringify(module)};installFatalHandlers(()=>${fd});process.on('SIGTERM',()=>console.log('cleanup'));setImmediate(()=>{${event}});`,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, ExitCode.Failure);
      assert.equal(result.stdout, EMPTY_OUTPUT);
      assert.doesNotMatch(result.stderr, /secret-marker|cleanup/);
      if (fd === STANDARD_ERROR_DESCRIPTOR) {
        const record = JSON.parse(result.stderr);
        assert.ok(
          ["uncaughtException", "unhandledRejection"].includes(record.kind),
        );
        assert.ok(Array.isArray(record.frames));
      }
    }
  }
});
