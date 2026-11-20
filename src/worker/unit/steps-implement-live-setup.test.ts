import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { suite, test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  EndReason,
  ExecutionEndKind,
  ExecutionStop,
} from "./execution-stop.ts";
import { executionBoundary } from "./native-method.ts";
import { unitsPlan } from "./step-units-plan.ts";
import { runStepsImplement } from "./steps-implement-host.ts";
import {
  advanceBase,
  commandTrees,
  implementFixture as fixture,
  TEST_SSH_ACCESS as LOCAL_SSH_ACCESS,
  task,
  transport,
} from "./test-support.ts";

const BASE_SIDE_FILE = "base-side";
const SETUP_DEADLINE_MS = 20000;
const PLAN_WAIT_TICKS = 50;
const BESIDE = "beside";
const MERGE_COMMIT_FIELDS = 3;
const UNITS_PLANNED = "units planned";
const SETUP_OUTPUT_FILE = "setup-output.txt";
const NODE_ONLY_SETUP_FAILURE = 'case "$PWD" in */checkouts/*) exit 1;; esac';
const ONE_COMMAND_TREE = 1;
const ORDER_POLL_MS = 20;
const FILE_WAIT_MS = 20000;
const STOP_ORDER_CODE = "test.stop_order";
const PLAN_FAILURE = "plan failed";
const INTERRUPTED_SETUP_SECONDS = 30;

interface SetupMarks {
  seen: string;
  started: string;
  planned: string;
}

async function liveSetupFixture(
  t: TestContext,
  command: (marks: SetupMarks) => string,
) {
  const root = temporary(t);
  const marks = {
    seen: join(root, "heads"),
    started: join(root, "started"),
    planned: join(root, "planned"),
  };
  const h = await fixture(
    t,
    [task("first", "true")],
    [],
    undefined,
    undefined,
    {
      source: EnvironmentSource.Detected,
      document: { postCreateCommand: command(marks) },
    },
  );
  await advanceBase(h, t, "base side", BASE_SIDE_FILE);
  await transport.fetchBase(
    h.root,
    "main",
    background,
    SETUP_DEADLINE_MS,
    LOCAL_SSH_ACCESS,
  );
  return { h, marks };
}

function interruptedSetup({ seen, started }: SetupMarks): string {
  return `git rev-parse HEAD >> '${seen}'; echo output > ${SETUP_OUTPUT_FILE}; touch '${started}'; sleep ${INTERRUPTED_SETUP_SECONDS}`;
}

async function fileAppears(path: string): Promise<void> {
  const deadline = Date.now() + FILE_WAIT_MS;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `${path} does not appear`);
    await delay(ORDER_POLL_MS);
  }
}

async function remoteNodeHead(h: { bare: string; nodeBranch: string }) {
  return (
    await simpleGit(h.bare).revparse([`refs/heads/${h.nodeBranch}`])
  ).trim();
}

async function assertMergedHeadPushed(
  h: { bare: string; nodeBranch: string },
  marks: SetupMarks,
): Promise<void> {
  const [merged] = readFileSync(marks.seen, "utf8").split("\n");
  assert.equal(await remoteNodeHead(h), merged);
  const files = await simpleGit(h.bare).raw([
    "ls-tree",
    "-r",
    "--name-only",
    `refs/heads/${h.nodeBranch}`,
  ]);
  assert.ok(!files.split("\n").includes(SETUP_OUTPUT_FILE));
}

suite("live setup", () => {
  test("the live setup runs on the merged heads beside units.plan, and its stop pushes the merged heads", async (t) => {
    const { h, marks } = await liveSetupFixture(
      t,
      ({ seen, started, planned }) =>
        `git rev-parse HEAD >> '${seen}'; touch '${started}'; i=0; while [ ! -e '${planned}' ] && [ $i -lt ${PLAN_WAIT_TICKS} ]; do sleep 0.1; i=$((i+1)); done; test -e '${planned}' && echo ${BESIDE} >> '${seen}'; exit 3`,
    );
    const plan = unitsPlan.run.bind(unitsPlan);
    t.mock.method(
      unitsPlan,
      "run",
      async (...args: Parameters<typeof plan>) => {
        await fileAppears(marks.started);
        return plan(...args);
      },
    );
    const log = h.run.log.bind(h.run);
    t.mock.method(h.run, "log", (...args: Parameters<typeof log>) => {
      if (args[0] === UNITS_PLANNED) writeFileSync(marks.planned, "");
      return log(...args);
    });
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    assert.ok(end.kind === ExecutionEndKind.Ended);
    assert.equal(end.reason, EndReason.EnvironmentFailed);
    const [merged, beside] = readFileSync(marks.seen, "utf8").split("\n");
    assert.equal(beside, BESIDE);
    assert.equal(
      (
        await simpleGit(h.bare).raw([
          "rev-list",
          "--parents",
          "-n",
          "1",
          merged!,
        ])
      )
        .trim()
        .split(" ").length,
      MERGE_COMMIT_FIELDS,
    );
    assert.equal(await remoteNodeHead(h), merged);
    assert.equal(commandTrees(h.input.workspaces).length, ONE_COMMAND_TREE);
  });

  test("a stop after the live setup took the base head tree gives that tree back to the command class", async (t) => {
    const { h } = await liveSetupFixture(t, () => NODE_ONLY_SETUP_FAILURE);
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    assert.ok(end.kind === ExecutionEndKind.Ended);
    assert.equal(end.reason, EndReason.ProviderFailed);
    assert.equal(commandTrees(h.input.workspaces).length, ONE_COMMAND_TREE);
  });

  test("a stop order during the live setup restores the merged heads, and the push leaves the setup output out", async (t) => {
    const { h, marks } = await liveSetupFixture(t, interruptedSetup);
    const order = setInterval(() => {
      if (!existsSync(marks.started)) return;
      clearInterval(order);
      h.run.operationContext.cancel(
        new ExecutionStop(EndReason.OperationFailed, STOP_ORDER_CODE),
      );
    }, ORDER_POLL_MS);
    t.after(() => clearInterval(order));
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    assert.ok(end.kind === ExecutionEndKind.Ended);
    assert.equal(end.reason, EndReason.OperationFailed);
    await assertMergedHeadPushed(h, marks);
  });

  test("a units.plan throw during the live setup restores the merged heads, and the push leaves the setup output out", async (t) => {
    const { h, marks } = await liveSetupFixture(t, interruptedSetup);
    t.mock.method(unitsPlan, "run", async () => {
      await fileAppears(marks.started);
      throw new Error(PLAN_FAILURE);
    });
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    assert.ok(end.kind === ExecutionEndKind.Ended);
    assert.equal(end.reason, EndReason.OperationFailed);
    await assertMergedHeadPushed(h, marks);
  });
});
