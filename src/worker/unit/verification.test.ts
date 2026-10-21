import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { background, CancellationContext } from "../../kernel/context.ts";
import {
  hostEnvironment,
  killIfPresent,
  temporary,
} from "../../kernel/test-support.ts";
import {
  runVerifications,
  runVerificationsWithOutput,
  verificationPassed,
  type VerificationInput,
  testedInputOf,
} from "./verification.ts";

test("verification runs in order and stops on the first failure or unstarted deadline", async (t) => {
  const expectedOrder = "first\nsecond\n";
  const input: VerificationInput = {
    directory: temporary(t),
    commands: ["true", "false", "true"],
    tested_input: { kind: "produced", sha256: "hash" },
    deadline: Date.now() + 10000,
    context: background,
    env: hostEnvironment(),
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
const ZOMBIE = "Z";
const NO_PROCESS_STATUS = 1;
const POSITIVE_PID = 0;

function childTerminated(pid: number): boolean {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
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
      env: hostEnvironment(),
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
  const commands = ['test -z "$ANTHROPIC_API_KEY"'];
  const result = await runVerifications({
    directory: temporary(t),
    commands,
    tested_input: { kind: "produced", sha256: "hash" },
    deadline: Date.now() + 10000,
    context: background,
    env: { ...hostEnvironment(), ANTHROPIC_API_KEY: "secret" },
  });
  assert.equal(verificationPassed(result, commands), true);
  assert.equal(result.results.length, commands.length);
});

const OUTPUT_TAIL_BYTES = 4096;
const LIMIT_BOUND_MS = 10000;

test("verification keeps the last 4 KiB of the output of each command", async (t) => {
  const run = await runVerificationsWithOutput({
    directory: temporary(t),
    commands: [
      "echo out; echo err >&2",
      "head -c 5000 /dev/zero | tr '\\0' a; printf END; exit 2",
    ],
    tested_input: { kind: "produced", sha256: "hash" },
    deadline: Date.now() + 10000,
    context: background,
    env: hostEnvironment(),
  });
  assert.deepEqual(
    run.verification.results.map(({ exit_code: exitCode }) => exitCode),
    [0, 2],
  );
  assert.match(run.outputs[0] ?? "", /out/);
  assert.match(run.outputs[0] ?? "", /err/);
  assert.equal(run.outputs[1]?.length, OUTPUT_TAIL_BYTES);
  assert.ok(run.outputs[1]?.endsWith("aEND"));
});

test("verification ends a command at its own limit before the execution deadline", async (t) => {
  const started = Date.now();
  const run = await runVerificationsWithOutput({
    directory: temporary(t),
    commands: ["echo started; sleep 30", "true"],
    tested_input: { kind: "produced", sha256: "hash" },
    deadline: Date.now() + 60000,
    context: background,
    env: hostEnvironment(),
    commandLimitMs: 1000,
  });
  assert.ok(Date.now() - started < LIMIT_BOUND_MS);
  assert.deepEqual(run.verification.results, [
    {
      command: "echo started; sleep 30",
      exit_code: null,
      signal: "SIGKILL",
      timed_out: true,
    },
  ]);
  assert.match(run.outputs[0] ?? "", /started/);
});

const FAILED_EXIT = 1;

test("a failed command that passes on a rerun is flaky and still fails", async (t) => {
  const directory = temporary(t);
  const input = {
    directory,
    commands: ["test -f once || { touch once; echo first-failure; exit 1; }"],
    tested_input: { kind: "produced" as const, sha256: "hash" },
    deadline: Date.now() + 10000,
    context: background,
    env: hostEnvironment(),
    reruns: 2,
  };
  const flaky = await runVerificationsWithOutput(input);
  assert.deepEqual(flaky.flaky, [true]);
  assert.equal(flaky.verification.results[0]?.exit_code, FAILED_EXIT);
  assert.match(flaky.outputs[0] ?? "", /first-failure/);
  assert.equal(verificationPassed(flaky.verification, input.commands), false);
  const stable = await runVerificationsWithOutput({
    ...input,
    commands: ["false"],
  });
  assert.deepEqual(stable.flaky, [false]);
  const unchecked = await runVerificationsWithOutput({
    ...input,
    commands: ["test -f twice || { touch twice; exit 1; }"],
    reruns: 0,
  });
  assert.deepEqual(unchecked.flaky, [false]);
});

test("the tested input is one address for one checkout and the list in binding order for two", () => {
  const api = {
    binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    name: "api",
    directory: "/w/checkouts/api",
    head: "a".repeat(40),
  };
  const web = {
    binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB",
    name: "web",
    directory: "/w/checkouts/web",
    head: "b".repeat(40),
  };
  assert.deepEqual(testedInputOf([api]), {
    kind: "repository",
    binding_id: api.binding_id,
    commit: api.head,
  });
  assert.deepEqual(
    testedInputOf([api, web]),
    [api, web].map((checkout) => ({
      kind: "repository",
      binding_id: checkout.binding_id,
      commit: checkout.head,
    })),
  );
});
