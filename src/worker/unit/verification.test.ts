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
  infrastructureStop,
  runVerifications,
  runVerificationsWithOutput,
  verificationPassed,
  VERIFICATION_INFRASTRUCTURE_FAILED,
  VerificationClass,
  type VerificationInput,
  testedInputOf,
} from "./verification.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { REASON_MAX_LENGTH } from "../../kernel/probe.ts";

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
  signal: AbortSignal,
): Promise<void> {
  while (!predicate()) await delay(POLL_MS, undefined, { signal });
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
        t.signal,
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
      await observe(() => childTerminated(child), t.signal);
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

const SIGNAL_KILL = "sh -c 'kill -9 $$'";
const EXIT_KILL = "sh -c 'kill -9 $$'; exit $?";
const KILLED_EXIT = 137;
const KILL_SIGNAL = "SIGKILL";
const COMMAND_ABSENT_EXIT = 127;
const SINGLE_RUN = 1;
const RUN_AND_RERUN = 2;

function countedInput(directory: string, commands: readonly string[]) {
  const runs: number[] = [];
  const input: VerificationInput = {
    observe: (attempt, execute) => {
      runs.push(attempt.run);
      return execute();
    },
    directory,
    commands,
    tested_input: { kind: "produced", sha256: "hash" },
    deadline: Date.now() + 10000,
    context: background,
    env: hostEnvironment(),
    reruns: 2,
  };
  return { input, runs };
}

test("a kill on the run and on its rerun is an infrastructure failure", async (t) => {
  for (const command of [SIGNAL_KILL, EXIT_KILL]) {
    const { input, runs } = countedInput(temporary(t), [command, "true"]);
    const run = await runVerificationsWithOutput(input);
    assert.equal(run.outcome, VerificationClass.Infrastructure);
    assert.equal(runs.length, RUN_AND_RERUN);
    assert.deepEqual(run.flaky, [false]);
    assert.equal(run.verification.results.length, SINGLE_RUN);
    const [result] = run.verification.results;
    assert.equal(result?.timed_out, false);
    if (command === SIGNAL_KILL) assert.equal(result?.signal, KILL_SIGNAL);
    else assert.equal(result?.exit_code, KILLED_EXIT);
  }
});

test("a spawn error on the run and on its rerun is an infrastructure failure", async (t) => {
  const { input, runs } = countedInput(join(temporary(t), "absent"), ["true"]);
  const run = await runVerificationsWithOutput(input);
  assert.equal(run.outcome, VerificationClass.Infrastructure);
  assert.equal(runs.length, RUN_AND_RERUN);
});

test("a kill on the run and a pass on the rerun is a pass and not flaky", async (t) => {
  const marker = join(temporary(t), "killed");
  const command = `test -f ${marker} || { touch ${marker}; kill -9 $$; }`;
  const { input, runs } = countedInput(temporary(t), [command, "true"]);
  const run = await runVerificationsWithOutput(input);
  assert.equal(run.outcome, VerificationClass.Pass);
  assert.deepEqual(runs, [1, 2, 1]);
  assert.deepEqual(run.flaky, [false, false]);
  assert.equal(verificationPassed(run.verification, input.commands), true);
});

test("a kill on the run and a code failure on the rerun keeps the flaky reruns", async (t) => {
  const marker = join(temporary(t), "killed");
  const command = `test -f ${marker} || { touch ${marker}; kill -9 $$; }; exit 1`;
  const { input, runs } = countedInput(temporary(t), [command]);
  const run = await runVerificationsWithOutput(input);
  assert.equal(run.outcome, VerificationClass.CodeFailure);
  assert.deepEqual(runs, [1, 2, 3, 4]);
  assert.deepEqual(run.flaky, [false]);
  assert.equal(run.verification.results[0]?.exit_code, FAILED_EXIT);
});

test("a command over the command limit is a code failure with no rerun", async (t) => {
  const { input, runs } = countedInput(temporary(t), ["sleep 30"]);
  const run = await runVerificationsWithOutput({
    ...input,
    commandLimitMs: 500,
  });
  assert.equal(run.outcome, VerificationClass.CodeFailure);
  assert.equal(runs.length, SINGLE_RUN);
  assert.equal(run.verification.results[0]?.timed_out, true);
});

test("a kill at the wall deadline and a command after the deadline are a budget end", async (t) => {
  const { input, runs } = countedInput(temporary(t), ["sleep 30"]);
  const killed = await runVerificationsWithOutput({
    ...input,
    deadline: Date.now() + 500,
  });
  assert.equal(killed.outcome, VerificationClass.BudgetEnd);
  assert.equal(runs.length, SINGLE_RUN);
  const unstarted = await runVerificationsWithOutput({
    ...input,
    deadline: Date.now(),
  });
  assert.equal(unstarted.outcome, VerificationClass.BudgetEnd);
  assert.equal(runs.length, SINGLE_RUN);
});

test("an exhausted budget makes a killed command a budget end with no rerun", async (t) => {
  const { input, runs } = countedInput(temporary(t), [SIGNAL_KILL]);
  const run = await runVerificationsWithOutput({
    ...input,
    exhausted: () => true,
  });
  assert.equal(run.outcome, VerificationClass.BudgetEnd);
  assert.equal(runs.length, SINGLE_RUN);
});

test("exit 127 is a code failure with no infrastructure rerun", async (t) => {
  const { input, runs } = countedInput(temporary(t), ["command-absent-x"]);
  const run = await runVerificationsWithOutput({ ...input, reruns: 0 });
  assert.equal(run.outcome, VerificationClass.CodeFailure);
  assert.equal(runs.length, SINGLE_RUN);
  assert.equal(run.verification.results[0]?.exit_code, COMMAND_ABSENT_EXIT);
});

test("an infrastructure failure stops with its code and a detail that names the command", async (t) => {
  const { input } = countedInput(temporary(t), [SIGNAL_KILL]);
  const run = await runVerificationsWithOutput(input);
  const stop = infrastructureStop(run);
  assert.ok(stop instanceof ExecutionStop);
  assert.equal(stop.reason, EndReason.OperationFailed);
  assert.equal(stop.code, VERIFICATION_INFRASTRUCTURE_FAILED);
  assert.match(stop.detail ?? "", /kill -9/);
  assert.match(stop.detail ?? "", /SIGKILL/);
  const { input: passing } = countedInput(temporary(t), ["true"]);
  assert.equal(
    infrastructureStop(await runVerificationsWithOutput(passing)),
    null,
  );
});

const LONG_COMMAND_LENGTH = 400;
const CANCEL_AFTER_MS = 200;

test("the infrastructure stop detail keeps the result before the cut of a long command", async (t) => {
  const prefix = `${SIGNAL_KILL} #`;
  const command = `${prefix}${"x ".repeat(LONG_COMMAND_LENGTH)}`.slice(
    0,
    LONG_COMMAND_LENGTH,
  );
  const { input } = countedInput(temporary(t), [command]);
  const stop = infrastructureStop(await runVerificationsWithOutput(input));
  assert.ok(stop);
  const detail = stop.detail ?? "";
  assert.equal(detail.length, REASON_MAX_LENGTH);
  assert.match(detail, /"signal":"SIGKILL"/);
  assert.match(detail, /"timed_out":false/);
  assert.match(detail, /"exit_code":null/);
  assert.ok(detail.includes(prefix));
});

test("a cancel in the middle of a command is a code failure with one run", async (t) => {
  const context = new CancellationContext();
  const { input, runs } = countedInput(temporary(t), ["sleep 30"]);
  const cancel = setTimeout(() => context.cancel(), CANCEL_AFTER_MS);
  t.after(() => clearTimeout(cancel));
  const run = await runVerificationsWithOutput({ ...input, context });
  assert.equal(run.outcome, VerificationClass.CodeFailure);
  assert.equal(runs.length, SINGLE_RUN);
  assert.equal(run.verification.results[0]?.timed_out, false);
  assert.equal(run.verification.results[0]?.signal, KILL_SIGNAL);
});
