import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import pino from "pino";
import { temporary } from "./test-support.ts";
import { OperationalLog, redactionPaths } from "./log.ts";

import { ExitCode } from "./apps/cli/constants.ts";

const EMPTY_OUTPUT = "";
const EMPTY_LOG_CONTENT = "";
const STANDARD_ERROR_DESCRIPTOR = process.stderr.fd;

test("every enumerated pino redaction path hides the secret", () => {
  for (const path of redactionPaths) {
    const fields = path.replace(/\["([^"]+)"\]/g, ".$1").split(".");
    const input: Record<string, unknown> = {};
    let parent = input;
    for (const field of fields.slice(0, -1)) {
      const child: Record<string, unknown> = {};
      parent[field] = child;
      parent = child;
    }
    parent[fields.at(-1)!] = "secret-marker";
    let output = "";
    pino(
      { redact: { paths: redactionPaths, censor: "[Redacted]" } },
      {
        write: (line) => {
          output += line;
        },
      },
    ).info(input);
    assert.doesNotMatch(output, /secret-marker/, path);
    assert.match(output, /Redacted/, path);
  }
});

test("logger keeps the validated descriptor and reopens a rotated file, rejecting an unsafe replacement", async (t) => {
  const directory = temporary(t);
  const path = join(directory, "kanthord.log");
  const old = join(directory, "rotated.log");
  const log = new OperationalLog(
    { level: "info", destination: "file" },
    directory,
  );
  log.logger.info("first");
  renameSync(path, old);
  writeFileSync(path, "", { mode: 0o600 });
  log.logger.info("still-original-descriptor");
  assert.match(readFileSync(old, "utf8"), /still-original-descriptor/);
  assert.equal(readFileSync(path, "utf8"), EMPTY_LOG_CONTENT);
  log.reopen();
  log.logger.info("replacement-descriptor");
  assert.match(readFileSync(path, "utf8"), /replacement-descriptor/);
  chmodSync(path, 0o644);
  assert.throws(() => log.reopen(), /mode 600/);
  await log.close();
});

test("fatal exceptions and rejections terminate without serializing secrets or running cleanup", () => {
  const module = new URL("./log.ts", import.meta.url).href;
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
