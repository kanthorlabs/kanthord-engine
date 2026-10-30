import assert from "node:assert/strict";
import { suite, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { background, CancellationContext } from "../../kernel/context.ts";
import {
  hostEnvironment,
  killIfPresent,
  SUITE_CONCURRENCY,
  temporary,
} from "../../kernel/test-support.ts";
import {
  commandClassOf,
  CommandEnd,
  environmentStop,
  infrastructureStop,
  runVerifications,
  runVerificationsWithOutput,
  testedInputOf,
  VERIFICATION_INFRASTRUCTURE_FAILED,
  VerificationClass,
  type VerificationInput,
  verificationPassed,
} from "./verification.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { VerificationContext } from "./method-telemetry.ts";
import { VerificationMemo } from "./verification-memo.ts";
import { REASON_MAX_LENGTH } from "../../kernel/probe.ts";
import { EnvironmentFailure } from "../../scheduler/contract.ts";
import {
  pidsIn,
  PROCESS_TREE_PIDS,
  processTreeCommand,
  spawnedPids,
  survivingProcesses,
} from "../../agent/test-support.ts";

suite("verification commands", { concurrency: SUITE_CONCURRENCY }, () => {
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
      (await runVerifications({ ...input, commands: ["kill -TERM $$"] }))
        .results,
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

  test("verification gives the child the variables and a variable replaces an environment variable of the same name", async (t) => {
    const commands = [
      'test "$EXTRA_VARIABLE" = extra',
      'test "$SHARED_VARIABLE" = replaced',
    ];
    const result = await runVerifications({
      directory: temporary(t),
      commands,
      tested_input: { kind: "produced", sha256: "hash" },
      deadline: Date.now() + 10000,
      context: background,
      env: { ...hostEnvironment(), SHARED_VARIABLE: "original" },
      variables: { EXTRA_VARIABLE: "extra", SHARED_VARIABLE: "replaced" },
    });
    assert.equal(verificationPassed(result, commands), true);
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

  const TREE_LIMIT_MS = 20000;

  test("a command that reaches its limit leaves no process of its tree, also a process in its own group", async (t) => {
    const run = await runVerificationsWithOutput({
      directory: temporary(t),
      commands: [processTreeCommand()],
      tested_input: { kind: "produced", sha256: "hash" },
      deadline: Date.now() + 60000,
      context: background,
      env: hostEnvironment(),
      commandLimitMs: TREE_LIMIT_MS,
    });
    const spawned = spawnedPids(t, [{ type: "text", text: run.outputs[0] }]);
    assert.equal(run.verification.results[0]?.timed_out, true);
    assert.equal(spawned.length, PROCESS_TREE_PIDS);
    assert.deepEqual(await survivingProcesses(spawned), []);
  });

  const TREE_START_POLLS = 100;
  const TREE_START_POLL_MS = 50;
  const TREE_PROCESS_GROUPS = 2;

  function processGroupOf(pid: number): string {
    return execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  }

  test("the sleep of the second process tree runs in its own process group", async (t) => {
    const child = spawn("bash", ["-c", processTreeCommand()], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ok(child.pid);
    const leader = child.pid;
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    for (
      let poll = 0;
      poll < TREE_START_POLLS &&
      pidsIn([{ type: "text", text: output }]).length < PROCESS_TREE_PIDS;
      poll += 1
    )
      await delay(TREE_START_POLL_MS);
    const spawned = spawnedPids(t, [{ type: "text", text: output }]);
    t.after(() => killIfPresent(-leader));
    assert.equal(spawned.length, PROCESS_TREE_PIDS);
    assert.equal(output.trim().split("\n").length, PROCESS_TREE_PIDS);
    assert.equal(
      new Set(spawned.map(processGroupOf)).size,
      TREE_PROCESS_GROUPS,
    );
  });

  const FAILED_EXIT = 1;
  const NO_EXIT = -1;

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
  test("a rerun of a failed command carries flaky_check and no other attempt does", async (t) => {
    const attempts: boolean[] = [];
    await runVerificationsWithOutput({
      observe: (attempt, execute) => {
        attempts.push(attempt.flaky_check);
        return execute();
      },
      directory: temporary(t),
      commands: ["false"],
      tested_input: { kind: "produced", sha256: "hash" },
      deadline: Date.now() + 10000,
      context: background,
      env: hostEnvironment(),
      reruns: 2,
    });
    assert.deepEqual(attempts, [false, true, true]);
  });

  function repeatedListRun(
    t: Parameters<typeof temporary>[0],
    copyRepeated?: boolean,
  ) {
    const directory = temporary(t);
    const count = join(directory, "count");
    const first = `echo x >> ${count}`;
    const attempts: number[] = [];
    const input: VerificationInput = {
      observe: (attempt, execute) => {
        attempts.push(attempt.index);
        return execute();
      },
      directory,
      commands: [first, "true", first],
      tested_input: { kind: "produced", sha256: "hash" },
      deadline: Date.now() + 10000,
      context: background,
      env: hostEnvironment(),
      ...(copyRepeated === undefined ? {} : { copyRepeated }),
    };
    return {
      attempts,
      lines: () => readFileSync(count, "utf8").trim().split("\n").length,
      run: () => runVerificationsWithOutput(input),
    };
  }

  test("a repeated command copies the result of its first pass when the copy applies", async (t) => {
    const repeated = repeatedListRun(t, true);
    const run = await repeated.run();
    assert.equal(run.verification.results.length, THREE_RESULTS);
    assert.deepEqual(run.verification.results[2], run.verification.results[0]);
    assert.equal(run.outputs[2], run.outputs[0]);
    assert.deepEqual(run.flaky, [false, false, false]);
    assert.equal(run.outcome, VerificationClass.Pass);
    assert.equal(repeated.lines(), SINGLE_RUN);
    assert.deepEqual(repeated.attempts, [0, 1]);
  });

  test("a repeated command runs again when the copy does not apply", async (t) => {
    const repeated = repeatedListRun(t);
    const run = await repeated.run();
    assert.equal(run.verification.results.length, THREE_RESULTS);
    assert.equal(repeated.lines(), RUN_AND_RERUN);
    assert.deepEqual(repeated.attempts, [0, 1, 2]);
  });

  function commandRun(exit_code: number | null, signal: string | null) {
    return {
      result: { command: "x", exit_code, signal, timed_out: false },
      output: "",
      end: CommandEnd.Exit,
    };
  }

  test("commandClassOf answers code_failure for a failed exit, infrastructure for a signal and pass for a success", () => {
    assert.equal(
      commandClassOf(commandRun(FAILED_EXIT, null)),
      VerificationClass.CodeFailure,
    );
    assert.equal(
      commandClassOf(commandRun(null, KILL_SIGNAL)),
      VerificationClass.Infrastructure,
    );
    assert.equal(commandClassOf(commandRun(0, null)), VerificationClass.Pass);
  });

  const EXIT_KILL = "sh -c 'kill -9 $$'; exit $?";
  const KILLED_EXIT = 137;
  const KILL_SIGNAL = "SIGKILL";
  const COMMAND_ABSENT_EXIT = 127;
  const SINGLE_RUN = 1;
  const THREE_RESULTS = 3;
  const RUN_AND_RERUN = 2;
  const TWO_COMMANDS_RUN = 2;

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
    const { input, runs } = countedInput(join(temporary(t), "absent"), [
      "true",
    ]);
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

  const REPEATED = "echo once >> count";
  const ONCE_LINE = "once\n";
  const TWICE_LINES = "once\nonce\n";

  test("a repeated command after a failure never runs and never copies", async (t) => {
    const { input, runs } = countedInput(temporary(t), [
      "false",
      "true",
      "false",
    ]);
    const run = await runVerificationsWithOutput({
      ...input,
      reruns: 0,
      copyRepeated: true,
    });
    assert.equal(run.outcome, VerificationClass.CodeFailure);
    assert.equal(runs.length, SINGLE_RUN);
    assert.equal(run.verification.results.length, SINGLE_RUN);
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

  test("exit 127 on the node head and on the base head is an environment failure", async (t) => {
    const { input, runs } = countedInput(temporary(t), ["command-absent-x"]);
    const asked: string[] = [];
    const run = await runVerificationsWithOutput({
      ...input,
      baseline: async (command) => {
        asked.push(command);
        return COMMAND_ABSENT_EXIT;
      },
    });
    assert.equal(run.outcome, VerificationClass.Environment);
    assert.deepEqual(asked, ["command-absent-x"]);
    assert.equal(runs.length, SINGLE_RUN);
    assert.deepEqual(run.flaky, [false]);
    const stop = environmentStop(run);
    assert.ok(stop instanceof ExecutionStop);
    assert.equal(stop.reason, EndReason.EnvironmentFailed);
    assert.equal(stop.code, EnvironmentFailure.CommandAbsent);
    assert.match(stop.detail ?? "", /command-absent-x/);
    assert.equal(infrastructureStop(run), null);
  });

  test("exit 127 only on the node head is a code failure", async (t) => {
    const { input } = countedInput(temporary(t), ["command-absent-x"]);
    for (const base of [0, FAILED_EXIT, NO_EXIT]) {
      const run = await runVerificationsWithOutput({
        ...input,
        baseline: async () => base,
      });
      assert.equal(run.outcome, VerificationClass.CodeFailure);
      assert.equal(environmentStop(run), null);
    }
  });

  test("exit 127 whose base rerun ends by budget is a budget end and not a code failure", async (t) => {
    const { input } = countedInput(temporary(t), ["command-absent-x"]);
    const run = await runVerificationsWithOutput({
      ...input,
      baseline: async () => null,
    });
    assert.equal(run.outcome, VerificationClass.BudgetEnd);
    assert.equal(environmentStop(run), null);
  });

  test("exit 127 with an exhausted budget is a budget end with no base rerun", async (t) => {
    const { input } = countedInput(temporary(t), ["command-absent-x"]);
    let asked = false;
    const run = await runVerificationsWithOutput({
      ...input,
      exhausted: () => true,
      baseline: async () => {
        asked = true;
        return COMMAND_ABSENT_EXIT;
      },
    });
    assert.equal(asked, false);
    assert.equal(run.outcome, VerificationClass.BudgetEnd);
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

  const MEMO_TREES = ["tree"];
  const MEMO_DIGESTS = ["digest"];
  const MEMO_LIMIT_MS = 300;
  const NO_RUNS = 0;

  function memoInput(
    directory: string,
    commands: readonly string[],
    memo: VerificationMemo,
    context: Parameters<VerificationMemo["scope"]>[0],
  ) {
    const counted = countedInput(directory, commands);
    const input: VerificationInput = {
      ...counted.input,
      reruns: 0,
      memo: memo.scope(context, MEMO_TREES, MEMO_DIGESTS),
    };
    return { input, runs: counted.runs };
  }

  test("a memo replay of a whole list runs no command and calls no observer", async (t) => {
    const directory = temporary(t);
    const memo = new VerificationMemo();
    const commands = [REPEATED, "true"];
    const first = memoInput(
      directory,
      commands,
      memo,
      VerificationContext.Task,
    );
    const fresh = await runVerificationsWithOutput(first.input);
    assert.equal(first.runs.length, TWO_COMMANDS_RUN);
    const second = memoInput(
      directory,
      commands,
      memo,
      VerificationContext.Task,
    );
    const replayed = await runVerificationsWithOutput(second.input);
    assert.deepEqual(second.runs, []);
    assert.equal(replayed.outcome, VerificationClass.Pass);
    assert.deepEqual(replayed.verification.results, fresh.verification.results);
    assert.deepEqual(replayed.outputs, fresh.outputs);
    assert.deepEqual(replayed.flaky, [false, false]);
    assert.equal(readFileSync(join(directory, "count"), "utf8"), ONCE_LINE);
  });

  test("a memo miss in the list runs the whole list again", async (t) => {
    const directory = temporary(t);
    const memo = new VerificationMemo();
    await runVerificationsWithOutput(
      memoInput(directory, [REPEATED], memo, VerificationContext.Task).input,
    );
    const second = memoInput(
      directory,
      [REPEATED, "true"],
      memo,
      VerificationContext.Task,
    );
    const run = await runVerificationsWithOutput(second.input);
    assert.equal(second.runs.length, TWO_COMMANDS_RUN);
    assert.equal(run.verification.results.length, TWO_COMMANDS_RUN);
    assert.equal(readFileSync(join(directory, "count"), "utf8"), TWICE_LINES);
  });

  test("a release memo replays a code failure and a live memo runs it again", async (t) => {
    for (const [context, secondRuns] of [
      [VerificationContext.Release, NO_RUNS],
      [VerificationContext.Task, TWO_COMMANDS_RUN],
    ] as const) {
      const memo = new VerificationMemo();
      const commands = ["true", "false", "true"];
      const first = memoInput(temporary(t), commands, memo, context);
      await runVerificationsWithOutput(first.input);
      assert.equal(first.runs.length, TWO_COMMANDS_RUN);
      const second = memoInput(temporary(t), commands, memo, context);
      const run = await runVerificationsWithOutput(second.input);
      assert.equal(run.outcome, VerificationClass.CodeFailure);
      assert.equal(run.verification.results.length, TWO_COMMANDS_RUN);
      assert.equal(second.runs.length, secondRuns);
    }
  });

  test("a timeout in a release run is stored in no memo entry and runs again on the next round", async (t) => {
    const memo = new VerificationMemo();
    for (const round of [1, 2]) {
      const { input, runs } = memoInput(
        temporary(t),
        ["sleep 30"],
        memo,
        VerificationContext.Release,
      );
      const run = await runVerificationsWithOutput({
        ...input,
        commandLimitMs: MEMO_LIMIT_MS,
      });
      assert.equal(
        run.outcome,
        VerificationClass.CodeFailure,
        `round ${round}`,
      );
      assert.equal(run.verification.results[0]?.timed_out, true);
      assert.equal(runs.length, SINGLE_RUN);
    }
  });

  test("a cancellation in a release run is stored in no memo entry and runs again on the next round", async (t) => {
    const memo = new VerificationMemo();
    const context = new CancellationContext();
    const cancel = setTimeout(() => context.cancel(), CANCEL_AFTER_MS);
    t.after(() => clearTimeout(cancel));
    const first = memoInput(
      temporary(t),
      ["sleep 30"],
      memo,
      VerificationContext.Release,
    );
    const cancelled = await runVerificationsWithOutput({
      ...first.input,
      context,
    });
    assert.equal(cancelled.outcome, VerificationClass.CodeFailure);
    assert.equal(first.runs.length, SINGLE_RUN);
    const second = memoInput(
      temporary(t),
      ["sleep 30"],
      memo,
      VerificationContext.Release,
    );
    await runVerificationsWithOutput({
      ...second.input,
      commandLimitMs: MEMO_LIMIT_MS,
    });
    assert.equal(second.runs.length, SINGLE_RUN);
  });

  test("a memo replay does not start after the deadline passed", async (t) => {
    const memo = new VerificationMemo();
    const first = memoInput(
      temporary(t),
      ["true"],
      memo,
      VerificationContext.Task,
    );
    await runVerificationsWithOutput(first.input);
    const second = memoInput(
      temporary(t),
      ["true"],
      memo,
      VerificationContext.Task,
    );
    const run = await runVerificationsWithOutput({
      ...second.input,
      deadline: Date.now(),
    });
    assert.equal(run.outcome, VerificationClass.BudgetEnd);
    assert.deepEqual(run.verification.results, []);
  });
});
