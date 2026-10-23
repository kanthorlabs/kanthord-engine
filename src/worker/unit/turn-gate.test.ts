import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { BudgetLimit, ExecutionStopReason } from "../../scheduler/contract.ts";
import {
  EndReason,
  ExecutionEndKind,
  type ExecutionEnd,
} from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import { taskCommitMessage } from "./local-git.ts";
import { RefreshResult, refreshAtClaim } from "./base-refresh.ts";
import {
  prepareStepsWorkspace,
  runStepsImplement,
  runTask,
  TaskResultKind,
} from "./steps-implement.ts";
import { TurnViolation } from "./turn-gate.ts";
import { WorkspaceKind } from "./workspace.ts";
import {
  advanceBase,
  commitOnNode,
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture as fixture,
  recordReleases,
  task,
  TEST_SSH_ACCESS,
} from "./test-support.ts";

const MET = 'kanthord-judgement: {"criterion_met":true,"rationale":"met"}';
const FIXED = "fixed";
const AGENT_SUBJECT = "agent commit";
const OTHER_BRANCH = "other";
const STRAY_FILE = "stray.txt";
const WORK_FILE = "work.txt";
const BUILD_OUTPUT = "build-output";
const RESOLVED = "resolved";
const MARKER_TEXT = "<<<<<<< x\n";
const MARKER_FILE = "notes";
const DEADLINE_MS = 20000;
const MERGE_COMMIT_FIELDS = 3;
const ONE_RELEASE = 1;
const COUNTED_TURNS = 5;

type Fixture = Awaited<ReturnType<typeof fixture>>;

const bash = (command: string) =>
  fauxAssistantMessage(fauxToolCall("bash", { command }), {
    stopReason: "toolUse",
  });

const write = (path: string, content: string) =>
  fauxAssistantMessage(fauxToolCall("write", { path, content }), {
    stopReason: "toolUse",
  });

const headOf = async (directory: string, ref = "HEAD") =>
  (await simpleGit(directory).revparse([ref])).trim();

const gitPath = (h: Fixture, name: string) => join(h.root, ".git", name);

async function remoteHead(h: Fixture): Promise<string> {
  return headOf(h.bare, `refs/heads/${h.nodeBranch}`);
}

async function assertAtBefore(h: Fixture, before: string): Promise<void> {
  assert.equal(
    (await simpleGit(h.root).raw(["symbolic-ref", "HEAD"])).trim(),
    `refs/heads/${h.nodeBranch}`,
  );
  assert.equal(await headOf(h.root), before);
  assert.equal(h.checkouts[0]!.head, before);
  assert.equal((await simpleGit(h.root).status()).isClean(), true);
  assert.equal(await remoteHead(h), before);
}

function violationEnd(end: ExecutionEnd, bodies: unknown[], code: string) {
  assert.ok("stop" in end);
  const detail = end.stop?.detail;
  assert.ok(detail);
  const stop = { reason: EndReason.OperationFailed, code, detail };
  assert.deepEqual(end, { kind: "released", furtherWork: true, stop });
  assert.deepEqual(bodies, [{ further_work: true, stop }]);
  return detail;
}

async function conflictFixture(
  t: TestContext,
  script: Parameters<typeof fixture>[2],
) {
  const h = await fixture(t, [], script);
  await commitOnNode(h.root, "node side");
  h.checkouts[0]!.head = await headOf(h.root);
  await advanceBase(h, t, "main side");
  return h;
}

async function fetchBase(h: Fixture): Promise<void> {
  await h.input.transport.fetchBase(
    h.root,
    "main",
    background,
    DEADLINE_MS,
    TEST_SSH_ACCESS,
  );
}

test("an agent commit in a turn folds into the template commit and counts as a change", async (t) => {
  const current = task("commit", `grep -q ${FIXED} file`);
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage("nothing"),
      fauxAssistantMessage("nothing again"),
      bash(`echo ${FIXED} > file && git commit -qam "${AGENT_SUBJECT}"`),
      fauxAssistantMessage("committed"),
      fauxAssistantMessage(MET),
    ],
  );
  const before = h.checkouts[0]!.head;
  assert.deepEqual(await runTask(h, current), {
    kind: TaskResultKind.Complete,
  });
  const subjects = await simpleGit(h.root).raw([
    "log",
    "--format=%s",
    `${before}..HEAD`,
  ]);
  assert.deepEqual(subjects.trim().split("\n"), [
    taskCommitMessage(current.id, h.input.claim.attempt),
  ]);
  assert.equal(await headOf(h.root, "HEAD^"), before);
  assert.equal(readFileSync(join(h.root, "file"), "utf8").trim(), FIXED);
  assert.equal(h.checkouts[0]!.head, await headOf(h.root));
});

test("the unchanged-turn counter spans the tasks of one execution", async (t) => {
  const first = task(
    "first",
    "test -f .git/seen || { touch .git/seen; false; }",
  );
  const second = task("second", "false");
  const h = await fixture(
    t,
    [first, second],
    [
      fauxAssistantMessage("nothing"),
      fauxAssistantMessage("nothing again"),
      fauxAssistantMessage(MET),
      fauxAssistantMessage("second nothing"),
      fauxAssistantMessage("second nothing again"),
      fauxAssistantMessage("never"),
    ],
  );
  assert.deepEqual(await runTask(h, first), {
    kind: TaskResultKind.Complete,
  });
  await assert.rejects(runTask(h, second), {
    reason: EndReason.NoProgress,
  });
  assert.equal(h.provider.calls.length, COUNTED_TURNS);
});

test("an agent branch switch stops with branch_changed and leaves the node ref at before", async (t) => {
  const h = await fixture(
    t,
    [task("branch", "false")],
    [
      bash(`git checkout -q -b ${OTHER_BRANCH} && echo moved > ${STRAY_FILE}`),
      fauxAssistantMessage("switched"),
    ],
  );
  const before = h.checkouts[0]!.head;
  const bodies = recordReleases(h);
  const end = await executionBoundary(h.run, () => runStepsImplement(h));
  const detail = violationEnd(end, bodies, TurnViolation.BranchChanged);
  assert.ok(detail.includes(OTHER_BRANCH));
  await assertAtBefore(h, before);
  assert.equal(existsSync(join(h.root, STRAY_FILE)), false);
});

test("an agent that leaves a rebase in progress stops with git_in_progress", async (t) => {
  const h = await fixture(
    t,
    [task("rebase", "false")],
    [bash("mkdir .git/rebase-merge"), fauxAssistantMessage("left")],
  );
  const before = h.checkouts[0]!.head;
  const bodies = recordReleases(h);
  const end = await executionBoundary(h.run, () => runStepsImplement(h));
  violationEnd(end, bodies, TurnViolation.GitInProgress);
  await assertAtBefore(h, before);
  assert.equal(existsSync(gitPath(h, "rebase-merge")), false);
});

test("the prepare restores invariant I from a left rebase and a turn runs", async (t) => {
  const current = task("restored", `test -f ${WORK_FILE}`);
  const h = await fixture(
    t,
    [current],
    [
      write(WORK_FILE, WORK_FILE),
      fauxAssistantMessage("done"),
      fauxAssistantMessage(MET),
    ],
  );
  mkdirSync(gitPath(h, "rebase-merge"));
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(h.input.claim.node_id),
    WorkspaceKind.Node,
  );
  const prepared = await prepareStepsWorkspace(h.input, h.run);
  assert.equal(existsSync(gitPath(h, "rebase-merge")), false);
  const state = { ...h, ...prepared };
  assert.deepEqual(await runTask(state, current), {
    kind: TaskResultKind.Complete,
  });
  assert.equal(
    (await simpleGit(h.root).raw(["ls-files", WORK_FILE])).trim(),
    WORK_FILE,
  );
});

test("a wall time end in a conflict turn aborts the merge and releases a budget end", async (t) => {
  const h = await conflictFixture(t, [
    write("file", RESOLVED),
    fauxAssistantMessage(RESOLVED),
  ]);
  await fetchBase(h);
  const before = h.checkouts[0]!.head;
  const instruct = h.agent.instruct.bind(h.agent);
  h.agent.instruct = async (work, text) => {
    await instruct(work, text);
    h.agent.budget.wallDeadlineReached();
  };
  const bodies = recordReleases(h);
  const stop = {
    reason: ExecutionStopReason.BudgetEnd,
    code: BudgetLimit.WallTime,
  };
  assert.deepEqual(await executionBoundary(h.run, () => runStepsImplement(h)), {
    kind: "released",
    furtherWork: true,
    stop,
  });
  assert.deepEqual(bodies, [{ further_work: true, stop }]);
  assert.equal(existsSync(gitPath(h, "MERGE_HEAD")), false);
  await assertAtBefore(h, before);
});

test("a marker line that the base brings outside the unmerged paths lets the merge conclude", async (t) => {
  const h = await conflictFixture(t, [
    write("file", RESOLVED),
    fauxAssistantMessage(RESOLVED),
  ]);
  await advanceBase(h, t, MARKER_TEXT, MARKER_FILE);
  await fetchBase(h);
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.equal(readFileSync(join(h.root, MARKER_FILE), "utf8"), MARKER_TEXT);
  const parents = await simpleGit(h.root).raw([
    "rev-list",
    "--parents",
    "-n",
    "1",
    "HEAD",
  ]);
  assert.equal(parents.trim().split(" ").length, MERGE_COMMIT_FIELDS);
  assert.equal(h.checkouts[0]!.head, await headOf(h.root));
  assert.equal(existsSync(gitPath(h, "MERGE_HEAD")), false);
});

test("a budget end during a verification that writes build output leaves no build output in the checkpoint", async (t) => {
  const h = await fixture(t, [task("build", `touch ${BUILD_OUTPUT}`)], []);
  const before = h.checkouts[0]!.head;
  let ended = false;
  h.agent.budget.exhausted = () =>
    (ended ||= existsSync(join(h.root, BUILD_OUTPUT)));
  const bodies = recordReleases(h);
  const end = await executionBoundary(h.run, () => runStepsImplement(h));
  assert.equal(end.kind, ExecutionEndKind.Released);
  assert.equal(bodies.length, ONE_RELEASE);
  assert.equal(existsSync(join(h.root, BUILD_OUTPUT)), false);
  const files = await simpleGit(h.bare).raw([
    "ls-tree",
    "-r",
    "--name-only",
    `refs/heads/${h.nodeBranch}`,
  ]);
  assert.equal(files.split("\n").includes(BUILD_OUTPUT), false);
  assert.equal(await remoteHead(h), before);
});
