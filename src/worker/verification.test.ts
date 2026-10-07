import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
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
    tested_input: { kind: "produced", sha256: "hash" },
    deadline: Date.now() + 10000,
    context: background,
  };
  const failed = await runVerifications(input);
  assert.deepEqual(
    failed.results.map(({ exit_code: exitCode }) => exitCode),
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
    [{ command: "exit 3", exit_code: 3, signal: null, timed_out: false }],
  );
  assert.deepEqual(
    (await runVerifications({ ...input, commands: ["kill -TERM $$"] })).results,
    [
      {
        command: "kill -TERM $$",
        exit_code: null,
        signal: "SIGTERM",
        timed_out: false,
      },
    ],
  );
});

const POLL_LIMIT = 100;
const POLL_MS = 20;
const PROCESS_ABSENT = "ESRCH";
const ZOMBIE = "Z";
const NO_PROCESS_STATUS = 1;
const POSITIVE_PID = 0;

function killIfPresent(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === PROCESS_ABSENT
    ))
      throw error;
  }
}

function childTerminated(pid: number): boolean {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
    }).trim();
    return state.startsWith(ZOMBIE);
  } catch (error) {
    if (
      error instanceof Error &&
      "status" in error &&
      error.status === NO_PROCESS_STATUS
    )
      return true;
    throw error;
  }
}

async function observe(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < POLL_LIMIT; attempt++) {
    if (predicate()) return;
    await delay(POLL_MS);
  }
  assert.fail(message);
}

for (const timedOut of [true, false]) {
  test(`verification terminates its child after ${timedOut ? "deadline" : "explicit cancellation"}`, async (t) => {
    const directory = temporary(t);
    const childFile = join(directory, "child");
    const shellFile = join(directory, "shell");
    const context = new CancellationContext();
    const running = runVerifications({
      directory,
      commands: ["echo $$ > shell; sleep 30 & echo $! > child; wait"],
      tested_input: { kind: "produced", sha256: "hash" },
      deadline: Date.now() + (timedOut ? 3000 : 10000),
      context,
    });
    try {
      await observe(
        () =>
          existsSync(childFile) &&
          readFileSync(childFile, "utf8").trim().length > POSITIVE_PID,
        "Verification child did not start within the bounded wait.",
      );
      const child = Number(readFileSync(childFile, "utf8").trim());
      assert.ok(Number.isSafeInteger(child) && child > POSITIVE_PID);
      assert.equal(childTerminated(child), false);
      if (!timedOut) context.cancel();
      const result = await running;
      assert.deepEqual(
        result.results.map(({ signal, timed_out: timedOut }) => ({
          signal,
          timedOut,
        })),
        [{ signal: "SIGKILL", timedOut }],
      );
      await observe(
        () => childTerminated(child),
        "Verification child survived termination of its shell.",
      );
    } finally {
      context.cancel();
      for (const file of [shellFile, childFile]) {
        if (!existsSync(file)) continue;
        const pid = Number(readFileSync(file, "utf8").trim());
        if (Number.isSafeInteger(pid) && pid > POSITIVE_PID)
          killIfPresent(file === shellFile ? -pid : pid);
      }
      await running;
    }
  });
}

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
    tested_input: { kind: "produced", sha256: "hash" },
    deadline: Date.now() + 10000,
    context: background,
  });
  assert.equal(verificationPassed(result, commands), true);
  assert.equal(result.results.length, commands.length);
});
