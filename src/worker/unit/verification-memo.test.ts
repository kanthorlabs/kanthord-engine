import assert from "node:assert/strict";
import { test } from "node:test";
import { VerificationContext } from "./method-telemetry.ts";
import {
  type MemoContext,
  type MemoScope,
  VerificationMemo,
} from "./verification-memo.ts";
import {
  CommandEnd,
  type CommandRun,
  VerificationClass,
} from "./verification.ts";

const TREES = ["tree-a"];
const DIGESTS = ["digest-a"];
const BUILD = "npm run build";
const TEST = "npm test";
const FAILED_EXIT = 1;
const ABSENT_EXIT = 127;
const KILLED_EXIT = 137;
const TWO_ENTRIES = 2;

function commandRun(
  command: string,
  exitCode: number | null,
  overrides: Partial<CommandRun> = {},
): CommandRun {
  return {
    result: {
      command,
      exit_code: exitCode,
      signal: null,
      timed_out: false,
    },
    output: `${command} output`,
    end: CommandEnd.Exit,
    ...overrides,
  };
}

function scopeOf(
  memo: VerificationMemo,
  context: MemoContext,
  trees: readonly string[] = TREES,
  digests: readonly string[] = DIGESTS,
): MemoScope {
  return memo.scope(context, trees, digests);
}

test("a pass is reused in the contexts task and node", () => {
  for (const context of [VerificationContext.Task, VerificationContext.Node]) {
    const scope = scopeOf(new VerificationMemo(), context);
    scope.ran(BUILD, commandRun(BUILD, 0), VerificationClass.Pass);
    const replayed = scope.replay([BUILD]);
    assert.deepEqual(replayed, [
      {
        result: commandRun(BUILD, 0).result,
        output: `${BUILD} output`,
        outcome: VerificationClass.Pass,
      },
    ]);
  }
});

test("a code failure is reused only in the context release", () => {
  const memo = new VerificationMemo();
  const failed = commandRun(TEST, FAILED_EXIT);
  for (const context of [VerificationContext.Task, VerificationContext.Node])
    scopeOf(memo, context).ran(TEST, failed, VerificationClass.CodeFailure);
  assert.equal(scopeOf(memo, VerificationContext.Task).replay([TEST]), null);
  assert.equal(scopeOf(memo, VerificationContext.Node).replay([TEST]), null);
  scopeOf(memo, VerificationContext.Release).ran(
    TEST,
    failed,
    VerificationClass.CodeFailure,
  );
  assert.deepEqual(scopeOf(memo, VerificationContext.Release).replay([TEST]), [
    {
      result: failed.result,
      output: failed.output,
      outcome: VerificationClass.CodeFailure,
    },
  ]);
});

test("a release result that is not a plain exit failure is not stored", () => {
  const cases: Array<[CommandRun, VerificationClass]> = [
    [
      commandRun(TEST, null, {
        end: CommandEnd.CommandLimit,
        result: {
          command: TEST,
          exit_code: null,
          signal: "SIGKILL",
          timed_out: true,
        },
      }),
      VerificationClass.CodeFailure,
    ],
    [
      commandRun(TEST, null, { end: CommandEnd.Cancelled }),
      VerificationClass.CodeFailure,
    ],
    [
      commandRun(TEST, null, { end: CommandEnd.WallDeadline }),
      VerificationClass.BudgetEnd,
    ],
    [commandRun(TEST, ABSENT_EXIT), VerificationClass.CodeFailure],
    [commandRun(TEST, ABSENT_EXIT), VerificationClass.Environment],
    [commandRun(TEST, KILLED_EXIT), VerificationClass.Infrastructure],
    [
      commandRun(TEST, null, { end: CommandEnd.SpawnError }),
      VerificationClass.Infrastructure,
    ],
    [commandRun(TEST, FAILED_EXIT), VerificationClass.BudgetEnd],
  ];
  for (const [run, outcome] of cases) {
    const scope = scopeOf(new VerificationMemo(), VerificationContext.Release);
    scope.ran(TEST, run, outcome);
    assert.equal(scope.replay([TEST]), null);
  }
});

test("a changed tree or a changed digest misses", () => {
  const memo = new VerificationMemo();
  scopeOf(memo, VerificationContext.Task).ran(
    BUILD,
    commandRun(BUILD, 0),
    VerificationClass.Pass,
  );
  assert.notEqual(
    scopeOf(memo, VerificationContext.Task).replay([BUILD]),
    null,
  );
  assert.equal(
    scopeOf(memo, VerificationContext.Task, ["tree-b"]).replay([BUILD]),
    null,
  );
  assert.equal(
    scopeOf(memo, VerificationContext.Task, TREES, ["digest-b"]).replay([
      BUILD,
    ]),
    null,
  );
  assert.equal(
    scopeOf(memo, VerificationContext.Task, TREES, []).replay([BUILD]),
    null,
  );
});

test("a result never crosses a context", () => {
  const memo = new VerificationMemo();
  scopeOf(memo, VerificationContext.Task).ran(
    BUILD,
    commandRun(BUILD, 0),
    VerificationClass.Pass,
  );
  assert.equal(scopeOf(memo, VerificationContext.Node).replay([BUILD]), null);
  assert.equal(
    scopeOf(memo, VerificationContext.Release).replay([BUILD]),
    null,
  );
});

test("the memo refuses the context evaluation", () => {
  assert.throws(() =>
    new VerificationMemo().scope(
      VerificationContext.Evaluation as MemoContext,
      TREES,
      DIGESTS,
    ),
  );
});

test("a release replay of passes only gives nothing", () => {
  const scope = scopeOf(new VerificationMemo(), VerificationContext.Release);
  scope.ran(BUILD, commandRun(BUILD, 0), VerificationClass.Pass);
  scope.ran(TEST, commandRun(TEST, 0), VerificationClass.Pass);
  assert.equal(scope.replay([BUILD]), null);
  assert.equal(scope.replay([BUILD, TEST]), null);
});

test("a replay gives a whole list or nothing", () => {
  const scope = scopeOf(new VerificationMemo(), VerificationContext.Task);
  scope.ran(BUILD, commandRun(BUILD, 0), VerificationClass.Pass);
  assert.equal(scope.replay([BUILD, TEST]), null);
  assert.equal(scope.replay([TEST, BUILD]), null);
  assert.equal(scope.replay([]), null);
  scope.ran(TEST, commandRun(TEST, 0), VerificationClass.Pass);
  assert.equal(scope.replay([BUILD, TEST])?.length, TWO_ENTRIES);
});

test("a replay counts a repeated command as a hit on its first entry", () => {
  const scope = scopeOf(new VerificationMemo(), VerificationContext.Task);
  scope.ran(BUILD, commandRun(BUILD, 0), VerificationClass.Pass);
  const replayed = scope.replay([BUILD, BUILD]);
  assert.equal(replayed?.length, TWO_ENTRIES);
  assert.equal(replayed?.[1], replayed?.[0]);
});

test("a replay ends at a stored code failure and needs no entry after it", () => {
  const scope = scopeOf(new VerificationMemo(), VerificationContext.Release);
  scope.ran(BUILD, commandRun(BUILD, 0), VerificationClass.Pass);
  scope.ran(TEST, commandRun(TEST, FAILED_EXIT), VerificationClass.CodeFailure);
  const replayed = scope.replay([BUILD, TEST, "never stored"]);
  assert.deepEqual(
    replayed?.map((entry) => entry.outcome),
    [VerificationClass.Pass, VerificationClass.CodeFailure],
  );
});
