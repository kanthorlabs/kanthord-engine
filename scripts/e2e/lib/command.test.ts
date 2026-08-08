import { test } from "node:test";
import assert from "node:assert/strict";

import { quoteArgv, runCommand } from "./command.ts";
import type { CommandRecord } from "./command.ts";
import { redactedMarker, secrets } from "./redact.ts";

test("quoteArgv joins tokens needing no quoting with one space", () => {
  assert.equal(quoteArgv(["git", "log", "--format=%H"]), "git log --format=%H");
});

test("quoteArgv single-quotes a token holding a space and escapes an inner apostrophe", () => {
  assert.equal(quoteArgv(["echo", "a b", "it's"]), "echo 'a b' 'it'\\''s'");
});

test("runCommand prints the quoted command to the sink before it records the result", async () => {
  const events: string[] = [];
  const sink = {
    print: (line: string) => {
      events.push(`print:${line}`);
    },
    record: (entry: CommandRecord) => {
      events.push(`record:${entry.exitCode}`);
    },
  };

  const record = await runCommand(sink, {
    argv: [process.execPath, "-e", "process.stdout.write('x')"],
  });

  assert.equal(record.exitCode, 0);
  assert.equal(record.stdout, "x");
  assert.deepEqual(
    events.map((event) => event.split(":")[0]),
    ["print", "record"],
  );
});

test("runCommand resolves a non-zero exit code without throwing", async () => {
  const sink = {
    print: () => {},
    record: () => {},
  };

  const record = await runCommand(sink, {
    argv: [process.execPath, "-e", "process.exitCode = 3"],
  });

  assert.equal(record.exitCode, 3);
});

test("runCommand passes an empty environment to the child by default", async () => {
  const sink = {
    print: () => {},
    record: () => {},
  };

  const record = await runCommand(sink, {
    argv: ["/usr/bin/env"],
  });

  assert.equal(record.stdout, "");
});

test("SECURITY: runCommand redacts a held secret out of the printed command line", async () => {
  const heldSecret = "cmd-print-secret-1";
  secrets.hold(heldSecret);

  const printed: string[] = [];
  const sink = {
    print: (line: string) => {
      printed.push(line);
    },
    record: () => {},
  };

  await runCommand(sink, {
    argv: [process.execPath, "-e", "0", heldSecret],
  });

  const printedLine = printed.join("\n");
  assert.equal(printedLine.includes(heldSecret), false);
  assert.equal(printedLine.includes(redactedMarker), true);
});

test("SECURITY: runCommand records raw stdout and stderr, so a disclosure assertion reads what the process actually emitted", async () => {
  const heldSecret = "cmd-stdout-secret-1";
  secrets.hold(heldSecret);

  const sink = {
    print: () => {},
    record: () => {},
  };

  const record = await runCommand(sink, {
    argv: [
      process.execPath,
      "-e",
      `process.stdout.write(${JSON.stringify(`out:${heldSecret}`)}); process.stderr.write(${JSON.stringify(`err:${heldSecret}`)});`,
    ],
  });

  assert.equal(record.stdout, `out:${heldSecret}`);
  assert.equal(record.stderr, `err:${heldSecret}`);
  assert.equal(record.stdout.includes(redactedMarker), false);
  assert.equal(record.stderr.includes(redactedMarker), false);
});
