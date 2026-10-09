import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";
import { temporary } from "./test-support.ts";
import { OperationalLog, redactionPaths } from "./log.ts";

const EMPTY_LOG_CONTENT = "";

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

test("the redaction paths hide the verification secret of a webhook inbound", () => {
  assert.ok(redactionPaths.includes("secret"));
  let output = "";
  pino(
    { redact: { paths: redactionPaths, censor: "[Redacted]" } },
    {
      write: (line) => {
        output += line;
      },
    },
  ).info({ address: "/hooks/inbound", secret: "secret-marker" });
  assert.doesNotMatch(output, /secret-marker/);
  assert.match(output, /\/hooks\/inbound/);
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
