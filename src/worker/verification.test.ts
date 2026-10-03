import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { background, CancellationContext } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  runVerifications,
  verificationPassed,
  type VerificationInput,
} from "./verification.ts";

test("verification runs in order and stops on the first failure or unstarted deadline", async (t) => {
  const expectedOrder = "first\nsecond\n";
  const input: VerificationInput = {
    directory: temporary(t),
    commands: ["true", "false", "true"],
    testedInput: { kind: "produced", sha256: "hash" },
    deadline: Date.now() + 10000,
    context: background,
  };
  const failed = await runVerifications(input);
  assert.deepEqual(
    failed.results.map(({ exitCode }) => exitCode),
    [0, 1],
  );
  assert.equal(verificationPassed(failed, input.commands), false);
  assert.deepEqual(
    (await runVerifications({ ...input, deadline: Date.now() })).results,
    [],
  );
  const ordered = ["echo first > order", "echo second >> order"];
  assert.equal(
    verificationPassed(
      await runVerifications({ ...input, commands: ordered }),
      ordered,
    ),
    true,
  );
  assert.equal(
    readFileSync(join(input.directory, "order"), "utf8"),
    expectedOrder,
  );
  assert.deepEqual(
    (await runVerifications({ ...input, commands: ["exit 3"] })).results,
    [{ command: "exit 3", exitCode: 3, signal: null, timedOut: false }],
  );
  assert.deepEqual(
    (await runVerifications({ ...input, commands: ["kill -TERM $$"] })).results,
    [
      {
        command: "kill -TERM $$",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
      },
    ],
  );
});

test("verification kills a timed-out group and distinguishes explicit cancellation", async (t) => {
  const directory = temporary(t);
  const input: VerificationInput = {
    directory,
    commands: ["sleep 5 & echo $! > child; wait"],
    testedInput: { kind: "produced", sha256: "hash" },
    deadline: Date.now() + 200,
    context: background,
  };
  const timedOut = await runVerifications(input);
  assert.deepEqual(
    timedOut.results.map(({ signal, timedOut }) => ({ signal, timedOut })),
    [{ signal: "SIGKILL", timedOut: true }],
  );
  const context = new CancellationContext();
  const timer = setTimeout(() => context.cancel(), 100);
  t.after(() => clearTimeout(timer));
  const cancelled = await runVerifications({
    ...input,
    context,
    deadline: Date.now() + 10000,
  });
  assert.deepEqual(
    cancelled.results.map(({ signal, timedOut }) => ({ signal, timedOut })),
    [{ signal: "SIGKILL", timedOut: false }],
  );
});

test("verification child gets no provider environment key", async (t) => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "secret";
  t.after(() => {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous;
  });
  const commands = ['test -z "$ANTHROPIC_API_KEY"'];
  const result = await runVerifications({
    directory: temporary(t),
    commands,
    testedInput: { kind: "produced", sha256: "hash" },
    deadline: Date.now() + 10000,
    context: background,
  });
  assert.equal(verificationPassed(result, commands), true);
  assert.equal(result.results.length, commands.length);
});
