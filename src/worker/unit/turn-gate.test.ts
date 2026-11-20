import assert from "node:assert/strict";
import { suite, test, type TestContext } from "node:test";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import {
  hostEnvironment,
  SUITE_CONCURRENCY,
  temporary,
} from "../../kernel/test-support.ts";
import { CauseCategory, unattributed } from "../../kernel/cause.ts";
import { background } from "../../kernel/context.ts";
import { REASON_MAX_LENGTH } from "../../kernel/probe.ts";
import { PromptTemplate } from "../../agent/contract.ts";
import {
  RecordKind,
  SpanStatus,
  type TelemetryRecord,
} from "../../tracking/contract.ts";
import { BudgetLimit, ExecutionStopReason } from "../../scheduler/contract.ts";
import {
  EndReason,
  type ExecutionEnd,
  ExecutionEndKind,
  ExecutionStop,
} from "./execution-stop.ts";
import { executionBoundary } from "./native-method.ts";
import { refreshAtClaim, RefreshResult } from "./base-refresh.ts";
import { type StepsState, TaskResultKind } from "./steps-implement.ts";
import {
  prepareStepsWorkspace,
  runStepsImplement,
  runTask,
} from "./steps-implement-host.ts";
import { SpanOperation, SpanRecorder } from "./telemetry.ts";
import {
  assertInvariant,
  gatedAgent,
  GateMode,
  restoreCheckout,
  TurnViolation,
} from "./turn-gate.ts";
import { operationsOf, readStatus, resolveGitPaths } from "./local-git.ts";
import { VerificationContext } from "./method-telemetry.ts";
import { memoScopeOf } from "./verification-memo.ts";
import { GIT_COMMIT_FAILED } from "./stop-codes.ts";
import { WorkspaceKind } from "./workspace-layout.ts";
import {
  advanceBase,
  commitOnNode,
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture as fixture,
  recordReleases,
  releasedRoot,
  task,
  TEST_SSH_ACCESS,
} from "./test-support.ts";

const FIXED = "fixed";
const MERGE_HEADER = "feat: merge main";
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
const ONE_COMMIT = 1;
const ONE_TURN = 1;
const ONE_PARENT_FIELDS = 2;
const COUNTED_TURNS = 4;
const CRLF_FILE = "f.txt";
const CRLF_CONTENT = "a\r\nb\r\n";
const HIJACKED_MESSAGE = "hijack";
const TURN_VIOLATION_LOG = "turn violation";
const ONE_GATE_SPAN = 1;
const NO_PROCESSES = 0;
const GATE_MESSAGE = "feat: gate work";
const CHANGED_FILE_COUNT = "kanthord.git.changed_file_count";
const CHANGED_FILES = "kanthord.git.changed_files";
const PROCESS_COUNT = "kanthord.git.process_count";
const ONE_CHANGED_FILE = 1;
const EMPTY_PROMPT = { text: "prompt", digest: "digest" };
const FAILING_SIGNER = "false";
const SIGNER_FAILURE = "failed to sign the data";
const TRACKED_FILE = "file";
const REWRITTEN_SUBJECT = "rewritten";
const GIT_BINARY = "git";
const WRAPPER_MODE = 0o700;
const INVARIANT_BRANCH = "main";
const SIDE_BRANCH = "side";
const STATUS = "status";
const UNCHANGED_TURN = [STATUS];
const CHANGED_TURN = [STATUS, "add", "diff", "commit", STATUS];
const CHANGED_TURN_M = [STATUS, "add", "diff", "hash-object", "commit", STATUS];
const COMMITTED_TURN = [
  STATUS,
  "merge-base",
  "rev-list",
  "reset",
  "add",
  "diff",
  "commit",
  STATUS,
];
const COMMITTED_TURN_M = [
  STATUS,
  "merge-base",
  "rev-list",
  "reset",
  "add",
  "diff",
  "hash-object",
  "commit",
  STATUS,
];
const CONVERSION_TURN = [
  STATUS,
  "add",
  "diff",
  "hash-object",
  "update-index",
  "commit",
  STATUS,
];
const CONVERSION_ONLY_TURN = [
  STATUS,
  "add",
  "diff",
  "hash-object",
  "update-index",
  STATUS,
];
const MOVED_GITDIR = "moved-gitdir";
const SUBMODULE = "sub";
const OUTSIDE_REF = `refs/remotes/origin/${OTHER_BRANCH}`;
const ONE_PUSH = 1;
const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
const RESTORE = ["checkout", "reset", "clean", STATUS];

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

const gitPath = (h: Fixture, name: string) =>
  join(releasedRoot(h), ".git", name);

async function remoteHead(h: Fixture): Promise<string> {
  return headOf(h.bare, `refs/heads/${h.nodeBranch}`);
}

async function assertAtBefore(h: Fixture, before: string): Promise<void> {
  assert.equal(
    (await simpleGit(releasedRoot(h)).raw(["symbolic-ref", "HEAD"])).trim(),
    `refs/heads/${h.nodeBranch}`,
  );
  assert.equal(await headOf(releasedRoot(h)), before);
  assert.equal(h.checkouts[0]!.head, before);
  assert.equal((await simpleGit(releasedRoot(h)).status()).isClean(), true);
  assert.equal(await remoteHead(h), before);
}

function recordSpans(h: Fixture): TelemetryRecord[] {
  const records: TelemetryRecord[] = [];
  (h.run as { spans: SpanRecorder }).spans = new SpanRecorder(
    h.run.claim,
    "coder-1",
    { write: (batch) => records.push(...batch), flush: async () => {} },
  );
  return records;
}

function spansOf(records: readonly TelemetryRecord[], operation: string) {
  const spans = records.flatMap((record) =>
    record.kind === RecordKind.Span && record.operation === operation
      ? [record]
      : [],
  );
  const starts = spans.filter((record) => "start_time" in record);
  const ends = spans.filter((record) => "end_time" in record);
  assert.equal(ends.length, starts.length);
  return starts.map((start) => ({
    start,
    end: ends.find((end) => end.span_id === start.span_id)!,
    texts: records.flatMap((record) =>
      record.kind === RecordKind.Text &&
      ends.some(
        (end) =>
          end.span_id === start.span_id &&
          end.text_ids?.includes(record.text_id),
      )
        ? [record.text]
        : [],
    ),
  }));
}

function gateSpan(records: readonly TelemetryRecord[]) {
  const spans = spansOf(records, SpanOperation.Gate);
  assert.equal(spans.length, ONE_GATE_SPAN);
  return spans[0]!;
}

function countGit(t: TestContext, h: Fixture): () => string[] {
  const bin = temporary(t);
  const log = join(bin, "commands");
  const git = (h.input.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => join(directory, GIT_BINARY))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  assert.ok(git);
  writeFileSync(
    join(bin, GIT_BINARY),
    `#!/bin/sh\nprintf '%s\\n' "$1" >> '${log}'\nexec '${git}' "$@"\n`,
    { mode: WRAPPER_MODE },
  );
  h.input.env.PATH = `${bin}${delimiter}${h.input.env.PATH}`;
  return () =>
    existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

function timedStatus(
  t: TestContext,
  h: Fixture,
  log: string,
  slow: string,
): string {
  const bin = temporary(t);
  const git = (h.input.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => join(directory, GIT_BINARY))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  assert.ok(git);
  writeFileSync(
    join(bin, GIT_BINARY),
    `#!/bin/sh\nif [ "$1" = status ]; then here="$(pwd -P)"; printf 'start %s\\n' "$here" >> '${log}'; if [ "$here" = '${slow}' ]; then sleep 0.6; else sleep 0.1; fi; printf 'end %s\\n' "$here" >> '${log}'; fi\nexec '${git}' "$@"\n`,
    { mode: WRAPPER_MODE },
  );
  return bin;
}

function countPushes(t: TestContext, h: Fixture): () => number {
  let pushes = 0;
  const push = h.input.transport.pushNodeBranch.bind(h.input.transport);
  t.mock.method(
    h.input.transport,
    "pushNodeBranch",
    async (...args: Parameters<typeof push>) => {
      pushes++;
      return push(...args);
    },
  );
  return () => pushes;
}

async function commitCrlfFile(h: Fixture): Promise<void> {
  const git = simpleGit(h.root);
  await git.raw(["config", "core.autocrlf", "false"]);
  writeFileSync(join(h.root, CRLF_FILE), CRLF_CONTENT);
  await git.add(CRLF_FILE);
  await git.commit("crlf");
  writeFileSync(join(h.root, ".gitattributes"), "*.txt text\n");
  await git.add(".gitattributes");
  await git.commit("attributes");
  h.checkouts[0]!.head = await headOf(h.root);
}

async function invariantRepository(t: TestContext) {
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.raw(["init", "-q", "-b", INVARIANT_BRANCH]);
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  writeFileSync(join(directory, TRACKED_FILE), "base\n");
  await git.add(TRACKED_FILE);
  await git.commit("base");
  const call = {
    env: hostEnvironment(),
    directory,
    context: background,
    deadlineMs: DEADLINE_MS,
  };
  const paths = await resolveGitPaths(call);
  const holds = async () => {
    assertInvariant(
      {
        status: await readStatus(call),
        operations: operationsOf(paths),
      },
      INVARIANT_BRANCH,
      await headOf(directory),
    );
  };
  await holds();
  return { directory, git, holds };
}

async function gatedTurn(
  h: Fixture,
  t: TestContext,
  work: () => Promise<void>,
): Promise<void> {
  t.mock.method(h.agent, "prompt", work);
  await gatedAgent(h, GATE_MESSAGE).prompt(EMPTY_PROMPT);
}

suite("turn gate", { concurrency: SUITE_CONCURRENCY }, () => {
  function configureFailingSigner(h: Fixture): void {
    appendFileSync(
      join(h.root, ".git", "config"),
      `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${FAILING_SIGNER}\n`,
    );
  }

  function violationEnd(end: ExecutionEnd, bodies: unknown[], code: string) {
    assert.ok("stop" in end);
    const detail = end.stop?.detail;
    assert.ok(detail);
    const stop = {
      reason: EndReason.OperationFailed,
      code,
      detail,
      cause: unattributed([CauseCategory.Model, CauseCategory.Prompt]),
    };
    assert.deepEqual(end, { kind: "released", furtherWork: true, stop });
    assert.deepEqual(bodies, [{ further_work: true, stop }]);
    return detail;
  }

  async function conflictFixture(
    t: TestContext,
    script: Parameters<typeof fixture>[2],
    tasks: Parameters<typeof fixture>[1] = [],
    turns?: number,
  ) {
    const h = await fixture(t, tasks, script, turns);
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
      ],
    );
    const before = h.checkouts[0]!.head;
    assert.deepEqual(await runTask(h, current), {
      kind: TaskResultKind.Complete,
      committed: true,
    });
    const subjects = await simpleGit(h.root).raw([
      "log",
      "--format=%s",
      `${before}..HEAD`,
    ]);
    assert.deepEqual(subjects.trim().split("\n"), [
      `feat: ${current.content.name}`,
    ]);
    assert.equal(await headOf(h.root, "HEAD^"), before);
    assert.equal(readFileSync(join(h.root, "file"), "utf8").trim(), FIXED);
    assert.equal(h.checkouts[0]!.head, await headOf(h.root));
  });

  test("a write turn that commits a merge of another branch stops with foreign_merge and leaves the node ref at before", async (t) => {
    const h = await fixture(
      t,
      [task("merge", "false")],
      [
        bash(
          `git checkout -q -b ${OTHER_BRANCH} && echo side > ${STRAY_FILE} && git add ${STRAY_FILE} && git commit -qm side && git checkout -q - && git merge -q --no-ff -m merged ${OTHER_BRANCH}`,
        ),
        fauxAssistantMessage("merged"),
      ],
    );
    const before = h.checkouts[0]!.head;
    const bodies = recordReleases(h);
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    const detail = violationEnd(end, bodies, TurnViolation.ForeignMerge);
    assert.ok(
      detail.includes(
        "A turn merges no branch; the worker merges the base itself.",
      ),
    );
    await assertAtBefore(h, before);
    assert.equal(existsSync(join(releasedRoot(h), STRAY_FILE)), false);
  });

  test("a write turn that commits ordinary commits settles as one commit", async (t) => {
    const current = task("commits", `test -f ${WORK_FILE}`);
    const h = await fixture(
      t,
      [current],
      [
        bash(
          `echo one > ${WORK_FILE} && git add ${WORK_FILE} && git commit -qm one && echo two >> ${WORK_FILE} && git commit -qam two`,
        ),
        fauxAssistantMessage("committed"),
      ],
    );
    const before = h.checkouts[0]!.head;
    assert.deepEqual(await runTask(h, current), {
      kind: TaskResultKind.Complete,
      committed: true,
    });
    const commits = await simpleGit(h.root).raw([
      "rev-list",
      "--parents",
      `${before}..HEAD`,
    ]);
    assert.equal(commits.trim().split("\n").length, ONE_COMMIT);
    assert.equal(commits.trim().split(" ").length, ONE_PARENT_FIELDS);
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
        fauxAssistantMessage("second nothing"),
        fauxAssistantMessage("second nothing again"),
        fauxAssistantMessage("never"),
      ],
    );
    assert.deepEqual(await runTask(h, first), {
      kind: TaskResultKind.Complete,
      committed: false,
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
        bash(
          `git checkout -q -b ${OTHER_BRANCH} && echo moved > ${STRAY_FILE}`,
        ),
        fauxAssistantMessage("switched"),
      ],
    );
    const before = h.checkouts[0]!.head;
    const bodies = recordReleases(h);
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    const detail = violationEnd(end, bodies, TurnViolation.BranchChanged);
    assert.ok(detail.includes(OTHER_BRANCH));
    await assertAtBefore(h, before);
    assert.equal(existsSync(join(releasedRoot(h), STRAY_FILE)), false);
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
      [write(WORK_FILE, WORK_FILE), fauxAssistantMessage("done")],
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
      committed: true,
    });
    assert.equal(
      (await simpleGit(h.root).raw(["ls-files", WORK_FILE])).trim(),
      WORK_FILE,
    );
  });

  const BUDGET_END_STOP = {
    reason: ExecutionStopReason.BudgetEnd,
    code: BudgetLimit.WallTime,
    cause: unattributed([CauseCategory.Plan, CauseCategory.Model]),
  };

  function endWallTimeAfterTurn(h: Fixture): void {
    const instruct = h.agent.instruct.bind(h.agent);
    h.agent.instruct = async (work, text, template) => {
      await instruct(work, text, template);
      h.agent.budget.wallDeadlineReached();
    };
  }

  test("a wall time end in a conflict turn with no marker left concludes the merge in the checkpoint and pushes the merge commit", async (t) => {
    const h = await conflictFixture(t, [
      write("file", RESOLVED),
      fauxAssistantMessage(RESOLVED),
    ]);
    await fetchBase(h);
    const before = h.checkouts[0]!.head;
    const base = await headOf(h.root, "origin/main");
    endWallTimeAfterTurn(h);
    const records = recordSpans(h);
    const bodies = recordReleases(h);
    assert.deepEqual(
      await executionBoundary(h.run, () => runStepsImplement(h)),
      { kind: "released", furtherWork: true, stop: BUDGET_END_STOP },
    );
    assert.deepEqual(bodies, [{ further_work: true, stop: BUDGET_END_STOP }]);
    const root = releasedRoot(h);
    assert.equal(existsSync(gitPath(h, "MERGE_HEAD")), false);
    const head = await headOf(root);
    assert.equal(await remoteHead(h), head);
    assert.deepEqual(
      (await simpleGit(root).raw(["rev-list", "--parents", "-n", "1", head]))
        .trim()
        .split(" ")
        .slice(1),
      [before, base],
    );
    assert.equal(
      (await simpleGit(root).raw(["log", "-1", "--format=%s", head])).trim(),
      MERGE_HEADER,
    );
    assert.equal(readFileSync(join(root, "file"), "utf8").trim(), RESOLVED);
    const { start, end } = gateSpan(records);
    assert.equal(start.attributes?.["kanthord.gate.mode"], GateMode.Checkpoint);
    assert.equal(end.attributes?.["kanthord.gate.changed"], true);
  });

  test("a wall time end in a conflict turn with markers left aborts the merge in the checkpoint and pushes the head before the merge", async (t) => {
    const h = await conflictFixture(t, [fauxAssistantMessage("unresolved")]);
    await fetchBase(h);
    const before = h.checkouts[0]!.head;
    endWallTimeAfterTurn(h);
    const bodies = recordReleases(h);
    assert.deepEqual(
      await executionBoundary(h.run, () => runStepsImplement(h)),
      { kind: "released", furtherWork: true, stop: BUDGET_END_STOP },
    );
    assert.deepEqual(bodies, [{ further_work: true, stop: BUDGET_END_STOP }]);
    assert.equal(existsSync(gitPath(h, "MERGE_HEAD")), false);
    await assertAtBefore(h, before);
  });

  test("a wall time end after the agent aborts the merge commits nothing in the checkpoint", async (t) => {
    const h = await conflictFixture(t, [
      bash("git merge --abort"),
      fauxAssistantMessage("aborted"),
    ]);
    await fetchBase(h);
    const before = h.checkouts[0]!.head;
    endWallTimeAfterTurn(h);
    const bodies = recordReleases(h);
    assert.deepEqual(
      await executionBoundary(h.run, () => runStepsImplement(h)),
      { kind: "released", furtherWork: true, stop: BUDGET_END_STOP },
    );
    assert.deepEqual(bodies, [{ further_work: true, stop: BUDGET_END_STOP }]);
    assert.equal((h as StepsState).openMerge?.resolved, true);
    await assertAtBefore(h, before);
  });

  test("the checkpoint of a stop aborts the open merge and pushes the head before the merge", async (t) => {
    const h = await conflictFixture(t, [
      write("file", RESOLVED),
      fauxAssistantMessage(RESOLVED),
    ]);
    await fetchBase(h);
    const before = h.checkouts[0]!.head;
    const base = await headOf(h.root, "origin/main");
    const instruct = h.agent.instruct.bind(h.agent);
    h.agent.instruct = async (work, text, template) => {
      await instruct(work, text, template);
      (h as StepsState).openMerge = {
        directory: h.root,
        commit: base,
        files: ["file"],
        markerless: [],
        message: MERGE_HEADER,
        resolved: true,
      };
      throw new ExecutionStop(EndReason.OperationFailed, null);
    };
    const bodies = recordReleases(h);
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    assert.ok("stop" in end && end.stop);
    assert.equal(end.stop.reason, EndReason.OperationFailed);
    assert.equal(bodies.length, ONE_RELEASE);
    assert.equal(existsSync(gitPath(h, "MERGE_HEAD")), false);
    await assertAtBefore(h, before);
  });

  test("a wall time end in a modify/delete conflict turn aborts the merge in the checkpoint because the conflict held no marker", async (t) => {
    const h = await fixture(t, [], [fauxAssistantMessage("unresolved")]);
    await simpleGit(h.root).rm(TRACKED_FILE);
    await simpleGit(h.root).commit("node delete");
    h.checkouts[0]!.head = await headOf(h.root);
    await advanceBase(h, t, "main side");
    await fetchBase(h);
    const before = h.checkouts[0]!.head;
    endWallTimeAfterTurn(h);
    const bodies = recordReleases(h);
    assert.deepEqual(
      await executionBoundary(h.run, () => runStepsImplement(h)),
      { kind: "released", furtherWork: true, stop: BUDGET_END_STOP },
    );
    assert.deepEqual(bodies, [{ further_work: true, stop: BUDGET_END_STOP }]);
    assert.equal((h as StepsState).openMerge?.resolved, false);
    assert.equal(existsSync(gitPath(h, "MERGE_HEAD")), false);
    await assertAtBefore(h, before);
  });

  test("a resolved open merge whose MERGE_HEAD holds another commit is aborted and commits nothing in the checkpoint", async (t) => {
    const h = await conflictFixture(t, [
      write("file", RESOLVED),
      fauxAssistantMessage(RESOLVED),
    ]);
    await fetchBase(h);
    const before = h.checkouts[0]!.head;
    const instruct = h.agent.instruct.bind(h.agent);
    h.agent.instruct = async (work, text, template) => {
      await instruct(work, text, template);
      writeFileSync(gitPath(h, "MERGE_HEAD"), `${before}\n`);
      h.agent.budget.wallDeadlineReached();
    };
    const bodies = recordReleases(h);
    assert.deepEqual(
      await executionBoundary(h.run, () => runStepsImplement(h)),
      { kind: "released", furtherWork: true, stop: BUDGET_END_STOP },
    );
    assert.deepEqual(bodies, [{ further_work: true, stop: BUDGET_END_STOP }]);
    assert.equal((h as StepsState).openMerge?.resolved, true);
    assert.equal(existsSync(gitPath(h, "MERGE_HEAD")), false);
    await assertAtBefore(h, before);
  });

  test("a turn budget end that aborts a conflict turn in progress concludes the resolved merge in the checkpoint", async (t) => {
    const h = await conflictFixture(
      t,
      [write("file", RESOLVED), fauxAssistantMessage(RESOLVED)],
      [],
      ONE_TURN,
    );
    await fetchBase(h);
    const before = h.checkouts[0]!.head;
    const base = await headOf(h.root, "origin/main");
    const stop = { ...BUDGET_END_STOP, code: BudgetLimit.Turns };
    const bodies = recordReleases(h);
    assert.deepEqual(
      await executionBoundary(h.run, () => runStepsImplement(h)),
      { kind: "released", furtherWork: true, stop },
    );
    assert.deepEqual(bodies, [{ further_work: true, stop }]);
    assert.equal(h.provider.calls.length, ONE_TURN);
    const root = releasedRoot(h);
    const head = await headOf(root);
    assert.equal(await remoteHead(h), head);
    assert.deepEqual(
      (await simpleGit(root).raw(["rev-list", "--parents", "-n", "1", head]))
        .trim()
        .split(" ")
        .slice(1),
      [before, base],
    );
  });

  test("a wall time end in the conflict turn of base.refresh(release) carries the open merge to the host checkpoint, which concludes it", async (t) => {
    const current = task("released-merge", `test -f ${WORK_FILE}`);
    const h = await conflictFixture(
      t,
      [
        write(WORK_FILE, WORK_FILE),
        fauxAssistantMessage("done"),
        write("file", RESOLVED),
        fauxAssistantMessage(RESOLVED),
      ],
      [current],
    );
    const instruct = h.agent.instruct.bind(h.agent);
    h.agent.instruct = async (work, text, template) => {
      await instruct(work, text, template);
      if (template === PromptTemplate.Conflict)
        h.agent.budget.wallDeadlineReached();
    };
    const bodies = recordReleases(h);
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    assert.ok("furtherWork" in end && end.furtherWork);
    assert.equal(bodies.length, ONE_RELEASE);
    assert.equal((h as StepsState).openMerge?.resolved, true);
    const root = releasedRoot(h);
    const head = await headOf(root);
    assert.equal(await remoteHead(h), head);
    assert.equal(
      (await simpleGit(root).raw(["log", "-1", "--format=%s", head])).trim(),
      MERGE_HEADER,
    );
    assert.equal(
      (await simpleGit(root).raw(["rev-list", "--parents", "-n", "1", head]))
        .trim()
        .split(" ").length,
      MERGE_COMMIT_FIELDS,
    );
    assert.equal(readFileSync(join(root, "file"), "utf8").trim(), RESOLVED);
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

  test("a conflict turn that concludes the merge of the base settles with two parents", async (t) => {
    const h = await conflictFixture(t, [
      write("file", RESOLVED),
      fauxAssistantMessage(RESOLVED),
    ]);
    await fetchBase(h);
    const before = h.checkouts[0]!.head;
    const base = await headOf(h.root, "origin/main");
    assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
    const parents = (
      await simpleGit(h.root).raw(["rev-list", "--parents", "-n", "1", "HEAD"])
    )
      .trim()
      .split(" ")
      .slice(1);
    assert.deepEqual(parents, [before, base]);
    assert.equal(h.checkouts[0]!.head, await headOf(h.root));
  });

  test("a conflict turn that also merges a third commit stops with foreign_merge and leaves the node ref at before", async (t) => {
    const h = await conflictFixture(t, [
      bash(
        `echo ${RESOLVED} > file && git commit -qam ${RESOLVED} && git merge -q --no-ff -m third $(git commit-tree -p origin/main -m side 'origin/main^{tree}')`,
      ),
      fauxAssistantMessage(RESOLVED),
    ]);
    await fetchBase(h);
    const before = h.checkouts[0]!.head;
    await assert.rejects(refreshAtClaim(h), {
      reason: EndReason.OperationFailed,
      code: TurnViolation.ForeignMerge,
    });
    assert.equal(await headOf(h.root), before);
    assert.equal(h.checkouts[0]!.head, before);
    assert.equal(existsSync(gitPath(h, "MERGE_HEAD")), false);
    assert.equal((await simpleGit(h.root).status()).isClean(), true);
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

  async function pushNodeBranch(h: Fixture): Promise<void> {
    await simpleGit(h.root).raw([
      "push",
      "-q",
      "origin",
      `HEAD:refs/heads/${h.nodeBranch}`,
    ]);
  }

  function releaseWorkspace(h: Fixture): void {
    h.input.workspaces.release(
      h.input.workspaces.nodeKey(h.input.claim.node_id),
      WorkspaceKind.Node,
    );
  }

  test("a CRLF blob under a text attribute keeps invariant I and the gate commits only the agent change", async (t) => {
    const current = task("crlf", `test -f ${WORK_FILE}`);
    const h = await fixture(
      t,
      [current],
      [
        fauxAssistantMessage("nothing"),
        write(WORK_FILE, WORK_FILE),
        fauxAssistantMessage("done"),
      ],
    );
    const git = simpleGit(h.root);
    await git.raw(["config", "core.autocrlf", "false"]);
    writeFileSync(join(h.root, CRLF_FILE), CRLF_CONTENT);
    await git.add(CRLF_FILE);
    await git.commit("crlf");
    writeFileSync(join(h.root, ".gitattributes"), "*.txt text\n");
    await git.add(".gitattributes");
    await git.commit("attributes");
    await pushNodeBranch(h);
    releaseWorkspace(h);
    const prepared = await prepareStepsWorkspace(h.input, h.run);
    const before = prepared.checkouts[0]!.head;
    const state = { ...h, ...prepared };
    assert.deepEqual(await runTask(state, current), {
      kind: TaskResultKind.Complete,
      committed: true,
    });
    const subjects = await git.raw(["log", "--format=%s", `${before}..HEAD`]);
    assert.deepEqual(subjects.trim().split("\n"), [
      `feat: ${current.content.name}`,
    ]);
    assert.equal(
      (await git.raw(["show", "--name-only", "--format=", "HEAD"])).trim(),
      WORK_FILE,
    );
    assert.equal(
      await git.raw(["cat-file", "blob", `HEAD:${CRLF_FILE}`]),
      CRLF_CONTENT,
    );
  });

  test("the prepare quits a git am that the agent left in progress", async (t) => {
    const h = await fixture(t, [task("am", "true")], []);
    const git = simpleGit(h.root);
    writeFileSync(join(h.root, "file"), "side\n");
    await git.raw(["commit", "-qam", "side"]);
    const patch = (
      await git.raw([
        "format-patch",
        "-1",
        "-o",
        join(h.root, ".kanthord-scratch"),
      ])
    ).trim();
    await git.raw(["reset", "-q", "--hard", "HEAD~1"]);
    writeFileSync(join(h.root, "file"), "other\n");
    await git.raw(["commit", "-qam", "other"]);
    await assert.rejects(git.raw(["am", patch]));
    assert.ok(existsSync(gitPath(h, "rebase-apply/applying")));
    releaseWorkspace(h);
    const prepared = await prepareStepsWorkspace(h.input, h.run);
    assert.equal(existsSync(gitPath(h, "rebase-apply")), false);
    assert.equal(prepared.checkouts[0]!.head, await headOf(h.root));
  });

  test("a violation in the checkpoint of a stop restores the checkout and pushes the node branch", async (t) => {
    const first = task("first", `test -f ${WORK_FILE}`);
    const second = task("second", "false");
    const h = await fixture(
      t,
      [first, second],
      [
        write(WORK_FILE, WORK_FILE),
        fauxAssistantMessage("done"),
        bash(`git checkout -q -b ${OTHER_BRANCH}`),
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "503 overloaded",
        }),
      ],
    );
    const events = t.mock.method(h.run, "log");
    recordReleases(h);
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    assert.ok("stop" in end);
    assert.equal(end.stop?.reason, EndReason.ProviderFailed);
    const local = await headOf(releasedRoot(h), `refs/heads/${h.nodeBranch}`);
    assert.equal(await remoteHead(h), local);
    assert.ok(
      (
        await simpleGit(releasedRoot(h)).raw([
          "log",
          "-1",
          "--format=%b",
          local,
        ])
      ).includes(first.id),
    );
    await assertAtBefore(h, local);
    assert.deepEqual(
      events.mock.calls
        .filter((call) => call.arguments[0] === TURN_VIOLATION_LOG)
        .map((call) => call.arguments[1].code),
      [TurnViolation.BranchChanged],
    );
  });

  test("the gate finds a rebase in progress behind a gitdir file that the turn writes and pushes the node branch at before", async (t) => {
    const h = await fixture(
      t,
      [task("gitdir", "false")],
      [
        bash(
          `mkdir "$(git rev-parse --git-path rebase-merge)" && mv .git ../${MOVED_GITDIR} && printf "gitdir: %s\\n" "$(cd .. && pwd)/${MOVED_GITDIR}" > .git`,
        ),
        fauxAssistantMessage("left"),
      ],
    );
    await commitOnNode(h.root, "earlier unit commit");
    const before = await headOf(h.root);
    h.checkouts[0]!.head = before;
    const pushes = countPushes(t, h);
    const bodies = recordReleases(h);
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    violationEnd(end, bodies, TurnViolation.GitInProgress);
    assert.equal(pushes(), ONE_PUSH);
    assert.equal(await remoteHead(h), before);
    assert.equal(
      existsSync(join(dirname(h.root), MOVED_GITDIR, "rebase-merge")),
      false,
    );
  });

  test("the merge commit takes the template message and not the merge message file", async (t) => {
    const h = await conflictFixture(t, [
      bash(
        `printf '${HIJACKED_MESSAGE}\\n' > "$(git rev-parse --git-path MERGE_MSG)"`,
      ),
      write("file", RESOLVED),
      fauxAssistantMessage(RESOLVED),
    ]);
    await fetchBase(h);
    assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
    assert.equal(
      (await simpleGit(h.root).raw(["log", "-1", "--format=%s"])).trim(),
      MERGE_HEADER,
    );
  });

  test("a write turn that changes a file writes one gate span with the mode and the change", async (t) => {
    const h = await fixture(t, [], []);
    const records = recordSpans(h);
    await gatedTurn(h, t, async () =>
      writeFileSync(join(h.root, WORK_FILE), WORK_FILE),
    );
    const { start, end } = gateSpan(records);
    assert.equal(start.attributes?.["kanthord.gate.mode"], GateMode.Write);
    assert.equal(start.parent_span_id, h.run.claim.root_span_id);
    assert.equal(end.status, SpanStatus.Ok);
    assert.equal(end.attributes?.["kanthord.gate.changed"], true);
    assert.equal("kanthord.gate.violation" in (end.attributes ?? {}), false);
    assert.equal(end.attributes?.[CHANGED_FILE_COUNT], ONE_CHANGED_FILE);
    assert.deepEqual(end.attributes?.[CHANGED_FILES], [WORK_FILE]);
  });

  test("a stopping violation writes the violation and ends the gate span with Error and no text", async (t) => {
    const h = await fixture(t, [], []);
    const records = recordSpans(h);
    await assert.rejects(
      gatedTurn(h, t, async () => {
        await simpleGit(h.root).checkoutLocalBranch(OTHER_BRANCH);
      }),
      { code: TurnViolation.BranchChanged },
    );
    const { end, texts } = gateSpan(records);
    assert.equal(end.status, SpanStatus.Error);
    assert.equal(CHANGED_FILE_COUNT in (end.attributes ?? {}), false);
    assert.equal(CHANGED_FILES in (end.attributes ?? {}), false);
    assert.equal(
      end.attributes?.["kanthord.gate.violation"],
      TurnViolation.BranchChanged,
    );
    assert.deepEqual(texts, []);
  });

  test("a failed gate commit ends the gate span with Error, the error code and the process count, with no git error text and no git span", async (t) => {
    const h = await fixture(t, [], []);
    const records = recordSpans(h);
    configureFailingSigner(h);
    await assert.rejects(
      gatedTurn(h, t, async () =>
        writeFileSync(join(h.root, WORK_FILE), WORK_FILE),
      ),
      { code: GIT_COMMIT_FAILED },
    );
    const { end, texts } = gateSpan(records);
    assert.equal(end.status, SpanStatus.Error);
    assert.equal(end.attributes?.["error.type"], GIT_COMMIT_FAILED);
    assert.ok(Number(end.attributes?.[PROCESS_COUNT]) > NO_PROCESSES);
    assert.equal("kanthord.gate.violation" in (end.attributes ?? {}), false);
    assert.deepEqual(texts, []);
    assert.equal(JSON.stringify(records).includes(SIGNER_FAILURE), false);
    assert.deepEqual(spansOf(records, SpanOperation.Git), []);
  });
  test("an unchanged turn runs one git status and writes the process count on its gate span", async (t) => {
    const h = await fixture(t, [], []);
    const commands = countGit(t, h);
    const records = recordSpans(h);
    const before = h.checkouts[0]!.head;
    await gatedTurn(h, t, async () => {});
    assert.deepEqual(commands(), UNCHANGED_TURN);
    assert.equal(h.checkouts[0]!.head, before);
    assert.equal(
      gateSpan(records).end.attributes?.[PROCESS_COUNT],
      UNCHANGED_TURN.length,
    );
  });

  test("a changed turn with no modified path runs five git processes", async (t) => {
    const h = await fixture(t, [], []);
    const commands = countGit(t, h);
    await gatedTurn(h, t, async () =>
      writeFileSync(join(h.root, WORK_FILE), WORK_FILE),
    );
    assert.deepEqual(commands(), CHANGED_TURN);
    assert.equal(h.checkouts[0]!.head, await headOf(h.root));
  });

  test("a changed turn with a modified path runs six git processes", async (t) => {
    const h = await fixture(t, [], []);
    const commands = countGit(t, h);
    await gatedTurn(h, t, async () =>
      writeFileSync(join(h.root, TRACKED_FILE), FIXED),
    );
    assert.deepEqual(commands(), CHANGED_TURN_M);
  });

  test("an agent-committed turn with no modified path runs eight git processes", async (t) => {
    const h = await fixture(t, [], []);
    const commands = countGit(t, h);
    const before = h.checkouts[0]!.head;
    await gatedTurn(h, t, async () => {
      writeFileSync(join(h.root, WORK_FILE), WORK_FILE);
      await simpleGit(h.root).add(WORK_FILE);
      await simpleGit(h.root).commit(AGENT_SUBJECT);
    });
    assert.deepEqual(commands(), COMMITTED_TURN);
    assert.equal(await headOf(h.root, "HEAD^"), before);
  });

  test("an agent-committed turn with a modified path runs nine git processes", async (t) => {
    const h = await fixture(t, [], []);
    const commands = countGit(t, h);
    await gatedTurn(h, t, async () => {
      writeFileSync(join(h.root, TRACKED_FILE), FIXED);
      await simpleGit(h.root).commit(AGENT_SUBJECT, [TRACKED_FILE]);
    });
    assert.deepEqual(commands(), COMMITTED_TURN_M);
  });

  test("a conversion-only path adds one git process to a changed turn", async (t) => {
    const h = await fixture(t, [], []);
    await commitCrlfFile(h);
    const commands = countGit(t, h);
    await gatedTurn(h, t, async () => {
      writeFileSync(join(h.root, CRLF_FILE), CRLF_CONTENT);
      writeFileSync(join(h.root, WORK_FILE), WORK_FILE);
    });
    assert.deepEqual(commands(), CONVERSION_TURN);
    assert.equal(
      (
        await simpleGit(h.root).raw([
          "show",
          "--name-only",
          "--format=",
          "HEAD",
        ])
      ).trim(),
      WORK_FILE,
    );
  });

  test("an entry with only a worktree-side change takes the slow path and commits nothing", async (t) => {
    const h = await fixture(t, [], []);
    await commitCrlfFile(h);
    const before = h.checkouts[0]!.head;
    const commands = countGit(t, h);
    const gated = gatedAgent(h, GATE_MESSAGE);
    t.mock.method(h.agent, "prompt", async () =>
      writeFileSync(join(h.root, CRLF_FILE), CRLF_CONTENT),
    );
    await gated.prompt(EMPTY_PROMPT);
    assert.deepEqual(commands(), CONVERSION_ONLY_TURN);
    assert.equal(gated.changed(), false);
    assert.equal(await headOf(h.root), before);
    assert.equal(h.checkouts[0]!.head, before);
  });

  test("the restore after a live verification runs four git processes", async (t) => {
    const h = await fixture(t, [], []);
    const commands = countGit(t, h);
    writeFileSync(join(h.root, TRACKED_FILE), FIXED);
    writeFileSync(join(h.root, STRAY_FILE), STRAY_FILE);
    await restoreCheckout(
      h.input.env,
      h.checkouts[0]!,
      h.nodeBranch,
      h.checkouts[0]!.head,
      background,
      () => DEADLINE_MS,
    );
    assert.deepEqual(commands(), RESTORE);
    assert.equal(existsSync(join(h.root, STRAY_FILE)), false);
  });

  test("the verification memo reads the tree id of a commit once", async (t) => {
    const h = await fixture(t, [], []);
    const commands = countGit(t, h);
    await memoScopeOf(h, VerificationContext.Task, [FIXED]);
    await memoScopeOf(h, VerificationContext.Task, [FIXED]);
    assert.deepEqual(commands(), ["rev-parse"]);
  });

  test("an agent that rewrites the history stops with history_rewritten and leaves the checkout at before", async (t) => {
    const h = await fixture(t, [], []);
    const before = h.checkouts[0]!.head;
    await assert.rejects(
      gatedTurn(h, t, async () => {
        await simpleGit(h.root).raw([
          "commit",
          "--amend",
          "--allow-empty",
          "-m",
          REWRITTEN_SUBJECT,
        ]);
      }),
      { code: TurnViolation.HistoryRewritten },
    );
    assert.equal(await headOf(h.root), before);
    assert.equal(h.checkouts[0]!.head, before);
  });

  test("a conflict turn that aborts the merge stops with merge_missing", async (t) => {
    const h = await conflictFixture(t, [
      bash("git merge --abort"),
      fauxAssistantMessage("aborted"),
    ]);
    await fetchBase(h);
    const before = h.checkouts[0]!.head;
    await assert.rejects(refreshAtClaim(h), {
      reason: EndReason.OperationFailed,
      code: TurnViolation.MergeMissing,
    });
    assert.equal(await headOf(h.root), before);
  });

  test("two violations in one turn stop with the code of the first check", async (t) => {
    const h = await fixture(t, [], []);
    const before = h.checkouts[0]!.head;
    await assert.rejects(
      gatedTurn(h, t, async () => {
        await simpleGit(h.root).checkoutLocalBranch(OTHER_BRANCH);
        mkdirSync(gitPath(h, "rebase-merge"));
      }),
      { code: TurnViolation.BranchChanged },
    );
    assert.equal(await headOf(h.root), before);
    assert.equal(existsSync(gitPath(h, "rebase-merge")), false);
  });

  test("two checkouts run the gate checks at the same time, two violations stop with the code of the lowest checkout index, and the violation restores every checkout", async (t) => {
    const h = await fixture(t, [], [], undefined, ["first", "second"]);
    const [first, second] = h.checkouts;
    assert.ok(first && second);
    const before = [first.head, second.head];
    const log = join(temporary(t), "status");
    const bin = timedStatus(t, h, log, realpathSync(first.directory));
    h.input.env.PATH = `${bin}${delimiter}${h.input.env.PATH}`;
    await assert.rejects(
      gatedTurn(h, t, async () => {
        mkdirSync(join(first.directory, ".git", "rebase-merge"));
        await simpleGit(second.directory).checkoutLocalBranch(OTHER_BRANCH);
      }),
      { code: TurnViolation.GitInProgress },
    );
    const events = readFileSync(log, "utf8").trim().split("\n");
    assert.deepEqual(
      events.slice(0, 2).map((event) => event.split(" ")[0]),
      ["start", "start"],
    );
    assert.equal(events[2], `end ${realpathSync(second.directory)}`);
    assert.equal(
      existsSync(join(first.directory, ".git", "rebase-merge")),
      false,
    );
    assert.equal(await headOf(first.directory), before[0]);
    assert.equal(await headOf(second.directory), before[1]);
    assert.equal(
      (
        await simpleGit(second.directory).revparse(["--abbrev-ref", "HEAD"])
      ).trim(),
      h.nodeBranch,
    );
  });

  test("a branch switch names the full refs in the branch_changed detail", async (t) => {
    const h = await fixture(t, [], []);
    await assert.rejects(
      gatedTurn(h, t, async () => {
        await simpleGit(h.root).checkoutLocalBranch(OTHER_BRANCH);
      }),
      {
        code: TurnViolation.BranchChanged,
        detail: await h.ports.secrets.redact(
          String(
            new Error(
              `The HEAD of checkout ${h.checkouts[0]!.name} is refs/heads/${OTHER_BRANCH}, not refs/heads/${h.nodeBranch}.`,
            ),
          ),
          REASON_MAX_LENGTH,
        ),
      },
    );
  });

  test("a HEAD that names a ref outside refs/heads names that ref in the branch_changed detail", async (t) => {
    const h = await fixture(t, [], []);
    await assert.rejects(
      gatedTurn(h, t, async () => {
        const git = simpleGit(h.root);
        await git.raw(["update-ref", OUTSIDE_REF, "HEAD"]);
        await git.raw(["symbolic-ref", "HEAD", OUTSIDE_REF]);
      }),
      {
        code: TurnViolation.BranchChanged,
        detail: await h.ports.secrets.redact(
          String(
            new Error(
              `The HEAD of checkout ${h.checkouts[0]!.name} is ${OUTSIDE_REF}, not refs/heads/${h.nodeBranch}.`,
            ),
          ),
          REASON_MAX_LENGTH,
        ),
      },
    );
  });

  test("a staged gitlink of a submodule with ignore all leaves the turn unchanged", async (t) => {
    const h = await fixture(t, [], []);
    const library = temporary(t);
    const lib = simpleGit(library);
    await lib.raw(["init", "-q", "-b", INVARIANT_BRANCH]);
    writeFileSync(join(library, TRACKED_FILE), TRACKED_FILE);
    await lib.add(TRACKED_FILE);
    await lib.raw([...IDENTITY, "commit", "-q", "-m", TRACKED_FILE]);
    const git = simpleGit(h.root, {
      unsafe: { allowUnsafeProtocolOverride: true },
    });
    await git.raw([
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      library,
      SUBMODULE,
    ]);
    await git.raw([
      "config",
      "-f",
      ".gitmodules",
      `submodule.${SUBMODULE}.ignore`,
      "all",
    ]);
    await git.raw(["add", "-A"]);
    await git.commit(SUBMODULE);
    const before = await headOf(h.root);
    h.checkouts[0]!.head = before;
    const gated = gatedAgent(h, GATE_MESSAGE);
    t.mock.method(h.agent, "prompt", async () => {
      const sub = simpleGit(join(h.root, SUBMODULE));
      writeFileSync(join(h.root, SUBMODULE, WORK_FILE), WORK_FILE);
      await sub.add(WORK_FILE);
      await sub.raw([...IDENTITY, "commit", "-q", "-m", WORK_FILE]);
      await git.raw(["add", "-A"]);
    });
    await gated.prompt(EMPTY_PROMPT);
    assert.equal(gated.changed(), false);
    assert.equal(await headOf(h.root), before);
    assert.equal(h.checkouts[0]!.head, before);
  });

  test("invariant I fails on a staged leftover", async (t) => {
    const repository = await invariantRepository(t);
    writeFileSync(join(repository.directory, WORK_FILE), WORK_FILE);
    await repository.git.add(WORK_FILE);
    await assert.rejects(repository.holds(), { name: "AssertionError" });
  });

  test("invariant I fails on an untracked file", async (t) => {
    const repository = await invariantRepository(t);
    writeFileSync(join(repository.directory, WORK_FILE), WORK_FILE);
    await assert.rejects(repository.holds(), { name: "AssertionError" });
  });

  test("invariant I fails on an unmerged path", async (t) => {
    const repository = await invariantRepository(t);
    const { directory, git } = repository;
    await git.checkoutLocalBranch(SIDE_BRANCH);
    writeFileSync(join(directory, TRACKED_FILE), SIDE_BRANCH);
    await git.commit(SIDE_BRANCH, [TRACKED_FILE]);
    await git.checkout(INVARIANT_BRANCH);
    writeFileSync(join(directory, TRACKED_FILE), INVARIANT_BRANCH);
    await git.commit(INVARIANT_BRANCH, [TRACKED_FILE]);
    await assert.rejects(git.merge([SIDE_BRANCH]));
    rmSync(join(directory, ".git", "MERGE_HEAD"));
    await assert.rejects(repository.holds(), { name: "AssertionError" });
  });

  test("invariant I fails on an operation path", async (t) => {
    const repository = await invariantRepository(t);
    mkdirSync(join(repository.directory, ".git", "rebase-merge"));
    await assert.rejects(repository.holds(), { name: "AssertionError" });
  });
});
