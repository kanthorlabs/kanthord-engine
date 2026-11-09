import assert from "node:assert/strict";
import { CauseCategory, unattributed } from "../../kernel/cause.ts";
import { suite, test } from "node:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { SUITE_CONCURRENCY, temporary } from "../../kernel/test-support.ts";
import type { ExecutionEnvironment } from "../contract.ts";
import type { TaskContent } from "../../mission/contract.ts";
import { EndReason } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import type { MethodClients } from "./method-clients.ts";
import {
  prepareStepsWorkspace,
  runStepsImplement,
  taskWork,
} from "./steps-implement.ts";
import { AFFECTED_DECLARATION_FILE } from "./affected.ts";
import { refreshAtRelease } from "./base-refresh.ts";
import { nodeUnitOf, releaseGate, ReleaseGateKind } from "./release-gate.ts";
import { noProgressDetail, NoProgressRule } from "./progress-rule.ts";
import { RELEASE_DIRECTORY, WorkspaceKind } from "./workspace.ts";
import { COMMAND_LIMIT_MS } from "./budget.ts";
import {
  advanceBase,
  affectedCommand,
  commandLimitClock,
  commitOnNode,
  declareAffected,
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture as fixture,
  listedVerificationSpans,
  nextExecution,
  recordReleases,
  recordSpans,
  releasedRoot,
  spanEnds,
  task,
} from "./test-support.ts";
import { RecordKind, SpanStatus } from "../../tracking/contract.ts";
import { SpanOperation } from "./telemetry.ts";
import { VerificationContext } from "./method-telemetry.ts";
import { VERIFICATION_RERUNS } from "./verification.ts";
import { PoolClass, repoKeyOf, TreeSource } from "./tree-pool.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

const NOTHING = fauxAssistantMessage("nothing");
const NO_PROGRESS_LIMIT = 2;
const RELEASE_COMMANDS_RAN = 2;
const FAILED_EXIT_CODE = 1;
const LAST_COMMAND_INDEX = 1;
const REVISION_TEXT = "Revise the task work";
const RELEASE_CLONE_TEXT =
  "The release clone holds only tracked files and the setup commands of the environment.";
const REVISED_CONTENT = "base two";
const SECRET = "secret";
const MARKER = "release-directory";
const ONE_SPAN = 1;
const NO_LOGS = 0;
const FLAKY_LOG = "verification flaky";
const TAG = "x";
const CONFIG_KEY = "a.b";
const BASE_CHANGE = "base change";
const LEFTOVER = "leftover";
const STRAY_FILE = "stray";
const FAILS_IN_RELEASE = 'case "$PWD" in */release/*) test -e fixed;; esac';
const STRAY = "stray";
const BUILD = "build";
const DEPS_SETUP = {
  postCreateCommand: "test -e deps || (mkdir deps && echo x > deps/marker)",
};
const NO_DEPS_SETUP = { postCreateCommand: "test ! -e deps" };
const TREE_PREPARED = "tree prepared";
const TREE_DELETED = "tree deleted";
const INVALID_PERMISSIONS = "system.files.invalid_permissions";
const RELEASE_FROM_POOL = { purpose: "release", source: TreeSource.Pool };
const ONE_TREE = 1;
const GONE = "gone";
const LEAK = "leak";
const OPEN_MODE = "755";
const POLL_MS = 20;
const ABORTED = "release aborted";

function storedEnvironment(
  document: Record<string, unknown>,
): ExecutionEnvironment {
  return {
    source: EnvironmentSource.Stored,
    document,
    digest: "d".repeat(64),
  };
}

function freeCommandTrees(h: Fixture): string[] {
  const pool = h.input.workspaces.pool;
  const directory = join(
    pool.root,
    repoKeyOf(h.input.setup.repositories[0]!.address),
    PoolClass.Command,
  );
  return pool
    .trees()
    .map((tree) => tree.path)
    .filter((path) => dirname(path) === directory);
}

function treesPrepared(t: TestContext, h: Fixture): () => unknown[] {
  const log = t.mock.method(h.run, "log");
  return () =>
    log.mock.calls
      .filter((call) => call.arguments[0] === TREE_PREPARED)
      .map((call) => call.arguments[1]);
}

function treesDeleted(t: TestContext, h: Fixture): () => unknown[] {
  const log = t.mock.method(h.run, "log");
  return () =>
    log.mock.calls
      .filter((call) => call.arguments[0] === TREE_DELETED)
      .map((call) => call.arguments[1]);
}

function objectInodes(directory: string): Set<number> {
  const inodes = new Set<number>();
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const entry = join(path, name);
      const stats = lstatSync(entry);
      if (stats.isDirectory()) walk(entry);
      else inodes.add(stats.ino);
    }
  };
  walk(join(directory, ".git", "objects"));
  return inodes;
}

function releaseKey(h: Fixture): string {
  return join(
    h.input.workspaces.nodeKey(h.input.claim.node_id),
    RELEASE_DIRECTORY,
  );
}

function write(path: string, content: string) {
  return fauxAssistantMessage(fauxToolCall("write", { path, content }), {
    stopReason: "toolUse",
  });
}

function recordRevisions(h: Fixture): string[] {
  const digests: string[] = [];
  const instruct = h.agent.instruct.bind(h.agent);
  h.agent.instruct = async (work, text, template) => {
    if (text.startsWith(REVISION_TEXT)) digests.push(work.digest);
    await instruct(work, text, template);
  };
  return digests;
}

function acceptEvidence(h: Fixture): void {
  h.run.clients.mission = {
    "evidence.submit": async () => ({
      type: "completed",
      status: 200,
      data: { evidence: {} },
    }),
  } as unknown as MethodClients["mission"];
}

function digestOf(h: Fixture, unit: TaskContent): string {
  return taskWork(h, unit).digest;
}

suite("release gate", { concurrency: SUITE_CONCURRENCY }, () => {
  test("a task that breaks the verification of an earlier task routes a revision to that task before the release", async (t) => {
    const first = task("first", "grep -q base file");
    const second = task("second", "grep -q two file");
    const h = await fixture(
      t,
      [first, second],
      [
        NOTHING,
        write("file", "two"),
        fauxAssistantMessage("done"),
        write("file", REVISED_CONTENT),
        fauxAssistantMessage("fixed"),
      ],
    );
    const revisions = recordRevisions(h);
    const bodies = recordReleases(h);
    acceptEvidence(h);
    assert.deepEqual(await runStepsImplement(h), {
      kind: "released",
      furtherWork: false,
    });
    assert.deepEqual(revisions, [digestOf(h, first)]);
    assert.deepEqual(bodies, [{ further_work: false, stop: null }]);
    assert.equal(
      await simpleGit(h.bare).raw(["show", `refs/heads/${h.nodeBranch}:file`]),
      REVISED_CONTENT,
    );
  });

  test("a release failure that no revision changes stops with no_progress and never releases further work false", async (t) => {
    const current = task("ignored", `test -e ${SECRET}`);
    const h = await fixture(
      t,
      [current],
      [
        NOTHING,
        fauxAssistantMessage("nothing again"),
        fauxAssistantMessage("still nothing"),
      ],
    );
    appendFileSync(join(h.root, ".git", "info", "exclude"), `${SECRET}\n`);
    writeFileSync(join(h.root, SECRET), SECRET);
    const revisions = recordRevisions(h);
    const bodies = recordReleases(h);
    acceptEvidence(h);
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    assert.deepEqual(revisions, [digestOf(h, current), digestOf(h, current)]);
    assert.deepEqual(end, {
      kind: "released",
      furtherWork: true,
      stop: {
        reason: EndReason.NoProgress,
        code: null,
        cause: unattributed([
          CauseCategory.Model,
          CauseCategory.Prompt,
          CauseCategory.Plan,
        ]),
        detail: noProgressDetail({
          rule: NoProgressRule.UnchangedRevision,
          count: NO_PROGRESS_LIMIT,
          limit: NO_PROGRESS_LIMIT,
          verification: {
            passed: false,
            ran: RELEASE_COMMANDS_RAN,
            index: LAST_COMMAND_INDEX,
            command: `test -e ${SECRET}`,
            limit_ms: COMMAND_LIMIT_MS,
            exit_code: FAILED_EXIT_CODE,
            timed_out: false,
          },
        }),
      },
    });
    assert.deepEqual(bodies, [
      {
        further_work: true,
        stop: {
          reason: EndReason.NoProgress,
          code: null,
          cause: unattributed([
            CauseCategory.Model,
            CauseCategory.Prompt,
            CauseCategory.Plan,
          ]),
          detail: noProgressDetail({
            rule: NoProgressRule.UnchangedRevision,
            count: NO_PROGRESS_LIMIT,
            limit: NO_PROGRESS_LIMIT,
            verification: {
              passed: false,
              ran: RELEASE_COMMANDS_RAN,
              index: LAST_COMMAND_INDEX,
              command: `test -e ${SECRET}`,
              limit_ms: COMMAND_LIMIT_MS,
              exit_code: FAILED_EXIT_CODE,
              timed_out: false,
            },
          }),
        },
      },
    ]);
  });

  const BUDGET_STOP = {
    reason: "budget_end",
    code: "wall_time",
    cause: unattributed([
      CauseCategory.Environment,
      CauseCategory.Plan,
      CauseCategory.Model,
    ]),
  };

  test("a wall deadline during a task verification releases further work", async (t) => {
    const h = await fixture(
      t,
      [task("timed", "touch transient; sleep 30")],
      [NOTHING],
    );
    let deadline = Date.now() + 60000;
    h.agent.budget.wallDeadline = () => {
      deadline = Date.now() + 30;
      return deadline;
    };
    h.agent.budget.exhausted = () => Date.now() >= deadline;
    const bodies = recordReleases(h);
    acceptEvidence(h);
    assert.deepEqual(await runStepsImplement(h), {
      kind: "released",
      furtherWork: true,
      stop: BUDGET_STOP,
    });
    assert.deepEqual(bodies, [{ further_work: true, stop: BUDGET_STOP }]);
  });

  const RELEASE_WINDOW_MS = 3000;

  test("a wall deadline during a release verification releases with the timed-out budget cause", async (t) => {
    const h = await fixture(t, [task("settled", "true")], [NOTHING]);
    h.revision = {
      ...h.revision,
      content: {
        ...h.revision.content,
        verifications: [
          `case "$PWD" in */${RELEASE_DIRECTORY}/*) sleep 30;; esac`,
        ],
      },
    };
    const releaseDirectory = join(
      h.input.workspaces.nodeKey(h.input.claim.node_id),
      RELEASE_DIRECTORY,
    );
    const wallDeadline = h.agent.budget.wallDeadline.bind(h.agent.budget);
    let deadline = Number.POSITIVE_INFINITY;
    h.agent.budget.wallDeadline = () => {
      if (!existsSync(releaseDirectory)) return wallDeadline();
      deadline = Math.min(deadline, Date.now() + RELEASE_WINDOW_MS);
      return deadline;
    };
    h.agent.budget.exhausted = () => Date.now() >= deadline;
    const bodies = recordReleases(h);
    acceptEvidence(h);
    assert.deepEqual(await runStepsImplement(h), {
      kind: "released",
      furtherWork: true,
      stop: BUDGET_STOP,
    });
    assert.deepEqual(bodies, [{ further_work: true, stop: BUDGET_STOP }]);
  });

  test("a failed command that the node and a task share routes its revision to the node unit", async (t) => {
    const current = task("shared", FAILS_IN_RELEASE);
    const h = await fixture(
      t,
      [current],
      [NOTHING, write("fixed", "fixed"), fauxAssistantMessage("fixed")],
    );
    h.revision = {
      ...h.revision,
      content: { ...h.revision.content, verifications: [FAILS_IN_RELEASE] },
    };
    const nodeUnit = nodeUnitOf(h.input.claim.node_id, h.revision);
    const revisions = recordRevisions(h);
    acceptEvidence(h);
    recordReleases(h);
    assert.deepEqual(await runStepsImplement(h), {
      kind: "released",
      furtherWork: false,
    });
    assert.deepEqual(revisions, [digestOf(h, nodeUnit)]);
  });

  test("a node command that fails at the release gate sends the node unit back to the gate with no live command, and an unchanged revision counts toward no_progress", async (t) => {
    const current = task("plain", "true");
    const h = await fixture(
      t,
      [current],
      [
        NOTHING,
        fauxAssistantMessage("nothing again"),
        fauxAssistantMessage("still nothing"),
      ],
    );
    h.revision = {
      ...h.revision,
      content: { ...h.revision.content, verifications: [`test -e ${SECRET}`] },
    };
    appendFileSync(join(h.root, ".git", "info", "exclude"), `${SECRET}\n`);
    writeFileSync(join(h.root, SECRET), SECRET);
    const records = recordSpans(h);
    const revisions = recordRevisions(h);
    recordReleases(h);
    acceptEvidence(h);
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    const node = nodeUnitOf(h.input.claim.node_id, h.revision);
    assert.deepEqual(revisions, [digestOf(h, node), digestOf(h, node)]);
    assert.ok("stop" in end && end.stop);
    assert.equal(end.stop.reason, EndReason.NoProgress);
    assert.deepEqual(JSON.parse(end.stop.detail!), {
      rule: NoProgressRule.UnchangedRevision,
      count: NO_PROGRESS_LIMIT,
      limit: NO_PROGRESS_LIMIT,
      verification: {
        passed: false,
        ran: ONE_SPAN,
        index: 0,
        command: `test -e ${SECRET}`,
        limit_ms: COMMAND_LIMIT_MS,
        exit_code: FAILED_EXIT_CODE,
        timed_out: false,
      },
    });
    const spans = listedVerificationSpans(records);
    assert.deepEqual(
      spans.filter((span) => span.context === VerificationContext.Node),
      [],
    );
    assert.equal(
      spans.filter((span) => span.context === VerificationContext.Release)
        .length,
      ONE_SPAN + VERIFICATION_RERUNS,
    );
  });

  test("a release verification that writes git state leaves the live checkout unchanged", async (t) => {
    const marker = join(temporary(t), MARKER);
    const h = await fixture(t, [task("plain", "true")], [NOTHING]);
    h.revision = {
      ...h.revision,
      content: {
        ...h.revision.content,
        verifications: [
          `git tag ${TAG} && git config ${CONFIG_KEY} c && pwd > ${marker}`,
        ],
      },
    };
    acceptEvidence(h);
    recordReleases(h);
    assert.deepEqual(await runStepsImplement(h), {
      kind: "released",
      furtherWork: false,
    });
    const directory = readFileSync(marker, "utf8").trim();
    assert.notEqual(directory, releasedRoot(h));
    assert.equal(
      directory,
      join(
        realpathSync(h.input.workspaces.nodeKey(h.input.claim.node_id)),
        RELEASE_DIRECTORY,
        h.checkouts[0]!.name,
      ),
    );
    assert.equal(
      (await simpleGit(releasedRoot(h)).tags()).all.includes(TAG),
      false,
    );
    assert.equal(
      (await simpleGit(releasedRoot(h)).getConfig(CONFIG_KEY, "local")).value,
      null,
    );
  });

  test("a release clone holds the remote of the reviewer clone and the fetched base", async (t) => {
    const markers = temporary(t);
    const base = join(markers, "base");
    const url = join(markers, "url");
    const h = await fixture(t, [], []);
    h.revision = {
      ...h.revision,
      content: {
        ...h.revision.content,
        verifications: [
          `git rev-parse origin/main > ${base} && git remote get-url origin > ${url}`,
        ],
      },
    };
    for (const change of [BASE_CHANGE, REVISED_CONTENT]) {
      await advanceBase(h, t, change, "other");
      assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
      const fetched = (await simpleGit(h.bare).revparse(["main"])).trim();
      assert.equal(readFileSync(base, "utf8").trim(), fetched);
      assert.equal(
        readFileSync(url, "utf8").trim(),
        h.input.setup.repositories[0]!.address,
      );
    }
  });

  test("the next prepare gives a release tree that a crash left back to the pool", async (t) => {
    const h = await fixture(t, [], []);
    const key = h.input.workspaces.nodeKey(h.input.claim.node_id);
    const tree = join(releaseKey(h), h.checkouts[0]!.name);
    await simpleGit().clone(h.root, tree);
    await simpleGit(tree).remote([
      "set-url",
      "origin",
      h.input.setup.repositories[0]!.address,
    ]);
    mkdirSync(join(releaseKey(h), LEFTOVER), { recursive: true });
    h.input.workspaces.release(key, WorkspaceKind.Node);
    await prepareStepsWorkspace(h.input, h.run);
    assert.equal(existsSync(releaseKey(h)), false);
    assert.equal(freeCommandTrees(h).length, ONE_TREE);
  });

  test("the next prepare deletes a release tree that a crash left when its binding holds another address", async (t) => {
    const h = await fixture(t, [], []);
    const key = h.input.workspaces.nodeKey(h.input.claim.node_id);
    const tree = join(releaseKey(h), h.checkouts[0]!.name);
    await simpleGit().clone(h.root, tree);
    await simpleGit(tree).remote(["set-url", "origin", temporary(t)]);
    h.input.workspaces.release(key, WorkspaceKind.Node);
    await prepareStepsWorkspace(h.input, h.run);
    assert.equal(existsSync(releaseKey(h)), false);
    assert.deepEqual(h.input.workspaces.pool.trees(), []);
  });

  test("the next prepare deletes a release tree whose .git is not a directory", async (t) => {
    const h = await fixture(t, [], []);
    const key = h.input.workspaces.nodeKey(h.input.claim.node_id);
    const tree = join(releaseKey(h), h.checkouts[0]!.name);
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, ".git"), `gitdir: ${join(h.root, ".git")}\n`);
    h.input.workspaces.release(key, WorkspaceKind.Node);
    await prepareStepsWorkspace(h.input, h.run);
    assert.equal(existsSync(releaseKey(h)), false);
    assert.deepEqual(h.input.workspaces.pool.trees(), []);
  });

  test("a passing release gate writes one release gate span with the result passed", async (t) => {
    const h = await fixture(t, [task("pass", "true")], []);
    const records = recordSpans(h);
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    const ends = spanEnds(records, SpanOperation.ReleaseGate);
    assert.equal(ends.length, ONE_SPAN);
    assert.equal(ends[0]?.status, SpanStatus.Ok);
    assert.deepEqual(ends[0]?.attributes, {
      "kanthord.release_gate.result": "passed",
      "kanthord.release_gate.affected": "absent",
    });
  });

  test("a failed release command writes the result routed with the unit id of its owner", async (t) => {
    const owner = task("owner", "false");
    const h = await fixture(t, [owner], []);
    const records = recordSpans(h);
    const gate = await releaseGate(h);
    assert.equal(gate.kind, ReleaseGateKind.Routed);
    assert.ok(gate.kind === ReleaseGateKind.Routed);
    assert.ok(gate.instruction.includes(RELEASE_CLONE_TEXT));
    const ends = spanEnds(records, SpanOperation.ReleaseGate);
    assert.equal(ends.length, ONE_SPAN);
    assert.equal(ends[0]?.status, SpanStatus.Ok);
    assert.deepEqual(ends[0]?.attributes, {
      "kanthord.release_gate.result": "routed",
      "kanthord.release_gate.unit_id": owner.id,
    });
  });

  test("the verification spans of a release name the owner of each command with the context release", async (t) => {
    const owner = task("owner", "true && true");
    const h = await fixture(t, [owner], []);
    h.revision = {
      ...h.revision,
      content: { ...h.revision.content, verifications: ["true"] },
    };
    const records = recordSpans(h);
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    const starts = records.flatMap((record) =>
      record.kind === RecordKind.Span &&
      record.operation === SpanOperation.Verification &&
      record.start_time !== undefined
        ? [record.attributes]
        : [],
    );
    assert.deepEqual(
      starts.map((attributes) => [
        attributes?.["kanthord.verification.context"],
        attributes?.["kanthord.verification.owner_id"],
      ]),
      [
        ["release", h.input.claim.node_id],
        ["release", owner.id],
      ],
    );
  });

  test("a command that the node and a task share runs once at the release gate and holds two results", async (t) => {
    const count = join(temporary(t), "count");
    const shared = `echo x >> ${count}`;
    const owner = task("owner", shared);
    const h = await fixture(t, [owner], []);
    h.revision = {
      ...h.revision,
      content: { ...h.revision.content, verifications: [shared] },
    };
    const records = recordSpans(h);
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    assert.equal(
      readFileSync(count, "utf8").trim().split("\n").length,
      ONE_SPAN,
    );
    const starts = records.flatMap((record) =>
      record.kind === RecordKind.Span &&
      record.operation === SpanOperation.Verification &&
      record.start_time !== undefined
        ? [record.attributes]
        : [],
    );
    assert.deepEqual(
      starts.map((attributes) => [
        attributes?.["kanthord.verification.context"],
        attributes?.["kanthord.verification.owner_id"],
      ]),
      [["release", h.input.claim.node_id]],
    );
    assert.deepEqual(h.lastVerification, {
      passed: true,
      ran: RELEASE_COMMANDS_RAN,
      index: LAST_COMMAND_INDEX,
      command: shared,
      limit_ms: COMMAND_LIMIT_MS,
      exit_code: 0,
      timed_out: false,
    });
  });

  test("a budget end writes the release gate result budget_end", async (t) => {
    const h = await fixture(t, [task("late", "true")], []);
    const records = recordSpans(h);
    h.agent.budget.exhausted = () => true;
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.BudgetEnd });
    const ends = spanEnds(records, SpanOperation.ReleaseGate);
    assert.equal(ends.length, ONE_SPAN);
    assert.deepEqual(ends[0]?.attributes, {
      "kanthord.release_gate.result": "budget_end",
    });
  });

  const BROKEN = "broken";
  const FAILS_WHEN_BROKEN = `grep -q ${BROKEN} file`;
  const ALWAYS_FAILS = "true";
  const NEVER_FAILS = "false";
  const RATIONALE_START = "The affected test run of repository repo failed.";
  const RATIONALE_FAILED = "1 test failed: a.test.ts > one.";

  async function changeNode(h: Fixture, content: string) {
    await commitOnNode(h.root, content);
    h.checkouts[0]!.head = (await simpleGit(h.root).revparse(["HEAD"])).trim();
  }

  function gateEnd(records: ReturnType<typeof recordSpans>) {
    const ends = spanEnds(records, SpanOperation.ReleaseGate);
    assert.equal(ends.length, ONE_SPAN);
    return ends[0]?.attributes;
  }

  test("an affected command that passes ends the gate with the verdict passed", async (t) => {
    const h = await fixture(t, [task("pass", "true")], []);
    await declareAffected(h, t, affectedCommand(NEVER_FAILS));
    await changeNode(h, "changed");
    const records = recordSpans(h);
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    assert.deepEqual(gateEnd(records), {
      "kanthord.release_gate.result": "passed",
      "kanthord.release_gate.affected": "passed",
    });
  });

  test("an affected command that fails at the node head and passes at the base routes one revision to the node unit", async (t) => {
    const h = await fixture(t, [task("pass", "true")], []);
    await declareAffected(h, t, affectedCommand(FAILS_WHEN_BROKEN));
    await changeNode(h, BROKEN);
    const records = recordSpans(h);
    const gate = await releaseGate(h);
    assert.equal(gate.kind, ReleaseGateKind.Routed);
    assert.ok(gate.kind === ReleaseGateKind.Routed);
    assert.equal(gate.unit.id, h.input.claim.node_id);
    assert.ok(gate.instruction.startsWith(REVISION_TEXT));
    assert.ok(gate.instruction.includes(RATIONALE_START));
    assert.ok(gate.instruction.includes(RATIONALE_FAILED));
    assert.ok(gate.instruction.includes(RELEASE_CLONE_TEXT));
    assert.deepEqual(gateEnd(records), {
      "kanthord.release_gate.result": "routed",
      "kanthord.release_gate.unit_id": h.input.claim.node_id,
      "kanthord.release_gate.affected": "failed",
    });
  });

  test("an affected test that fails at both heads passes the gate with the verdict base_red", async (t) => {
    const h = await fixture(t, [task("pass", "true")], []);
    await declareAffected(h, t, affectedCommand(ALWAYS_FAILS));
    await changeNode(h, "changed");
    const records = recordSpans(h);
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    assert.deepEqual(gateEnd(records), {
      "kanthord.release_gate.result": "passed",
      "kanthord.release_gate.affected": "base_red",
    });
  });

  test("a failed listed command routes its revision and runs no affected command", async (t) => {
    const marker = join(temporary(t), "affected-ran");
    const h = await fixture(t, [task("owner", "false")], []);
    await declareAffected(
      h,
      t,
      affectedCommand(`touch ${marker}; ${ALWAYS_FAILS}`),
    );
    await changeNode(h, "changed");
    const records = recordSpans(h);
    assert.equal((await releaseGate(h)).kind, ReleaseGateKind.Routed);
    assert.equal(existsSync(marker), false);
    assert.equal(
      gateEnd(records)?.["kanthord.release_gate.affected"],
      undefined,
    );
  });

  function flakyInRelease(marker: string): string {
    return `case "$PWD" in */${RELEASE_DIRECTORY}/*) test -f ${marker} || { touch ${marker}; echo flaky-output; exit 1; };; esac`;
  }

  test("a release verification that fails once and passes on a rerun releases, logs verification flaky and runs the affected step", async (t) => {
    const directory = temporary(t);
    const command = flakyInRelease(join(directory, "flaky"));
    const affectedMarker = join(directory, "affected-ran");
    const h = await fixture(t, [task("pass", "true")], []);
    h.revision = {
      ...h.revision,
      content: { ...h.revision.content, verifications: [command] },
    };
    await declareAffected(
      h,
      t,
      affectedCommand(`touch ${affectedMarker}; ${ALWAYS_FAILS}`),
    );
    await changeNode(h, "changed");
    const events = t.mock.method(h.run, "log");
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    assert.equal(existsSync(affectedMarker), true);
    const flaky = events.mock.calls
      .filter((call) => call.arguments[0] === FLAKY_LOG)
      .map((call) => call.arguments[1]);
    assert.deepEqual(flaky, [{ flaky: [{ index: 0, command }] }]);
  });

  test("a release verification that fails on every rerun returns the failed run", async (t) => {
    const h = await fixture(t, [task("owner", "true")], []);
    h.revision = {
      ...h.revision,
      content: {
        ...h.revision.content,
        verifications: [FAILS_IN_RELEASE],
      },
    };
    const events = t.mock.method(h.run, "log");
    const gate = await releaseGate(h);
    assert.ok(gate.kind === ReleaseGateKind.Routed);
    assert.equal(gate.unit.id, h.input.claim.node_id);
    assert.ok(gate.instruction.includes(RELEASE_CLONE_TEXT));
    assert.equal(
      events.mock.calls.filter((call) => call.arguments[0] === FLAKY_LOG)
        .length,
      NO_LOGS,
    );
  });

  test("a node change that edits the declaration does not change the command that judges it", async (t) => {
    const h = await fixture(t, [task("pass", "true")], []);
    await declareAffected(h, t, affectedCommand(FAILS_WHEN_BROKEN));
    await refreshAtRelease(h);
    writeFileSync(
      join(h.root, AFFECTED_DECLARATION_FILE),
      JSON.stringify({ version: 1, command: affectedCommand(NEVER_FAILS) }),
    );
    await simpleGit(h.root).add(AFFECTED_DECLARATION_FILE);
    await changeNode(h, BROKEN);
    const gate = await releaseGate(h);
    assert.equal(gate.kind, ReleaseGateKind.Routed);
  });

  test("a second release round keeps each file of a setup root and removes residue outside the setup roots", async (t) => {
    const h = await fixture(
      t,
      [],
      [],
      undefined,
      undefined,
      storedEnvironment(DEPS_SETUP),
    );
    h.revision = {
      ...h.revision,
      content: {
        ...h.revision.content,
        verifications: [`test ! -e ${STRAY} && test ! -e ${BUILD}`],
      },
    };
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    const [tree] = freeCommandTrees(h);
    assert.ok(tree);
    const before = lstatSync(join(tree, "deps", "marker"));
    writeFileSync(join(tree, STRAY), STRAY);
    mkdirSync(join(tree, BUILD));
    writeFileSync(join(tree, BUILD, STRAY), STRAY);
    await changeNode(h, "changed");
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    const [again] = freeCommandTrees(h);
    assert.ok(again);
    const after = lstatSync(join(again, "deps", "marker"));
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(existsSync(join(again, STRAY)), false);
    assert.equal(existsSync(join(again, BUILD)), false);
  });

  test("a fresh release tree shares no object file with the checkout", async (t) => {
    const h = await fixture(t, [], []);
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    const [tree] = freeCommandTrees(h);
    assert.ok(tree);
    const checkout = objectInodes(h.root);
    assert.deepEqual(
      [...objectInodes(tree)].filter((ino) => checkout.has(ino)),
      [],
    );
  });

  test("a second node of the same repository reuses the release tree", async (t) => {
    const first = await fixture(t, [], []);
    assert.deepEqual(await releaseGate(first), {
      kind: ReleaseGateKind.Passed,
    });
    const second = await nextExecution(
      t,
      {
        ...first,
        input: {
          ...first.input,
          claim: { ...first.input.claim, node_id: createIdentity("node") },
        },
      },
      [],
      dirname(first.input.workspaces.root),
    );
    const prepared = treesPrepared(t, second);
    assert.deepEqual(await releaseGate(second), {
      kind: ReleaseGateKind.Passed,
    });
    assert.deepEqual(prepared(), [RELEASE_FROM_POOL]);
    assert.equal(freeCommandTrees(second).length, ONE_TREE);
  });

  test("a release round on a changed environment runs the setup on a tree with no earlier setup output", async (t) => {
    const h = await fixture(
      t,
      [],
      [],
      undefined,
      undefined,
      storedEnvironment(DEPS_SETUP),
    );
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    h.setup = h.setup.map((entry) => ({
      ...entry,
      environment: NO_DEPS_SETUP,
    }));
    const prepared = treesPrepared(t, h);
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    assert.deepEqual(prepared(), [RELEASE_FROM_POOL]);
  });

  test("a release tree with an index lock is reused, the lock is absent and the gate passes", async (t) => {
    const h = await fixture(t, [], []);
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    const [tree] = freeCommandTrees(h);
    assert.ok(tree);
    writeFileSync(join(tree, ".git", "index.lock"), "");
    const prepared = treesPrepared(t, h);
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    assert.deepEqual(prepared(), [RELEASE_FROM_POOL]);
    const [again] = freeCommandTrees(h);
    assert.ok(again);
    assert.equal(existsSync(join(again, ".git", "index.lock")), false);
  });

  test("the release gate gives its tree back to the command class", async (t) => {
    const h = await fixture(t, [], []);
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    assert.equal(freeCommandTrees(h).length, ONE_TREE);
    assert.equal(h.input.workspaces.pool.trees().length, ONE_TREE);
    assert.equal(existsSync(releaseKey(h)), false);
  });

  test("a release tree drops the checkout of a binding that the node no longer holds", async (t) => {
    const h = await fixture(t, [], []);
    mkdirSync(join(releaseKey(h), GONE, ".git"), { recursive: true });
    h.revision = {
      ...h.revision,
      content: {
        ...h.revision.content,
        verifications: [`test ! -e ../${GONE}`],
      },
    };
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    assert.equal(h.input.workspaces.pool.trees().length, ONE_TREE);
    assert.equal(existsSync(releaseKey(h)), false);
  });

  test("a release tree whose .git mode a verification changes is deleted at the give, and the gate and the next prepare pass", async (t) => {
    const h = await fixture(t, [], []);
    h.revision = {
      ...h.revision,
      content: {
        ...h.revision.content,
        verifications: [`chmod ${OPEN_MODE} .git`],
      },
    };
    const deleted = treesDeleted(t, h);
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    assert.deepEqual(deleted(), [
      {
        path: join(releaseKey(h), h.checkouts[0]!.name),
        code: INVALID_PERMISSIONS,
      },
    ]);
    assert.deepEqual(h.input.workspaces.pool.trees(), []);
    assert.equal(existsSync(releaseKey(h)), false);
    const key = h.input.workspaces.nodeKey(h.input.claim.node_id);
    h.input.workspaces.release(key, WorkspaceKind.Node);
    await prepareStepsWorkspace(h.input, h.run);
  });

  test("the next prepare deletes a crash leftover whose .git mode is open, and the prepare passes", async (t) => {
    const h = await fixture(t, [], []);
    const key = h.input.workspaces.nodeKey(h.input.claim.node_id);
    const tree = join(releaseKey(h), h.checkouts[0]!.name);
    await simpleGit().clone(h.root, tree);
    await simpleGit(tree).remote([
      "set-url",
      "origin",
      h.input.setup.repositories[0]!.address,
    ]);
    chmodSync(join(tree, ".git"), Number.parseInt(OPEN_MODE, 8));
    h.input.workspaces.release(key, WorkspaceKind.Node);
    const deleted = treesDeleted(t, h);
    await prepareStepsWorkspace(h.input, h.run);
    assert.deepEqual(deleted(), [{ path: tree, code: INVALID_PERMISSIONS }]);
    assert.equal(existsSync(releaseKey(h)), false);
    assert.deepEqual(h.input.workspaces.pool.trees(), []);
  });

  test("a release tree that is a symbolic link is removed as a link, and its target stays out of the pool", async (t) => {
    const h = await fixture(t, [], []);
    const key = h.input.workspaces.nodeKey(h.input.claim.node_id);
    const outside = join(temporary(t), "outside");
    await simpleGit().clone(h.root, outside);
    await simpleGit(outside).remote([
      "set-url",
      "origin",
      h.input.setup.repositories[0]!.address,
    ]);
    mkdirSync(releaseKey(h), { recursive: true });
    symlinkSync(outside, join(releaseKey(h), h.checkouts[0]!.name));
    h.input.workspaces.release(key, WorkspaceKind.Node);
    await prepareStepsWorkspace(h.input, h.run);
    assert.equal(existsSync(releaseKey(h)), false);
    assert.deepEqual(h.input.workspaces.pool.trees(), []);
    assert.equal(existsSync(join(outside, ".git")), true);
    assert.equal(
      existsSync(join(outside, ".git", "kanthord-pool.json")),
      false,
    );
  });

  test("the pool gives back a release tree that is a symbolic link as a removed link", async (t) => {
    const h = await fixture(t, [], []);
    const outside = join(temporary(t), "outside");
    await simpleGit().clone(h.root, outside);
    const link = join(temporary(t), "link");
    symlinkSync(outside, link);
    h.input.workspaces.pool.giveBack(
      {
        address: h.input.setup.repositories[0]!.address,
        poolClass: PoolClass.Command,
      },
      link,
      h.input.claim.node_id,
    );
    assert.equal(existsSync(link), false);
    assert.deepEqual(h.input.workspaces.pool.trees(), []);
    assert.equal(
      existsSync(join(outside, ".git", "kanthord-pool.json")),
      false,
    );
  });

  test("a release round with an existing tree of a current checkout passes", async (t) => {
    const h = await fixture(t, [], []);
    await simpleGit().clone(h.root, join(releaseKey(h), h.checkouts[0]!.name));
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    assert.equal(existsSync(releaseKey(h)), false);
  });

  test("a release round does not follow a symbolic link that replaces the release directory", async (t) => {
    const h = await fixture(t, [], []);
    const outside = temporary(t);
    const name = h.checkouts[0]!.name;
    await simpleGit().clone(h.root, join(outside, name));
    writeFileSync(join(outside, STRAY_FILE), STRAY_FILE);
    symlinkSync(outside, releaseKey(h));
    assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    assert.equal(existsSync(join(outside, name, ".git")), true);
    assert.equal(existsSync(join(outside, STRAY_FILE)), true);
    assert.equal(existsSync(releaseKey(h)), false);
  });

  test("a tag that a release verification creates is absent in the next release round", async (t) => {
    const h = await fixture(t, [], []);
    h.revision = {
      ...h.revision,
      content: {
        ...h.revision.content,
        verifications: [
          `! git rev-parse -q --verify refs/tags/${LEAK} && git tag ${LEAK}`,
        ],
      },
    };
    for (const content of ["changed", REVISED_CONTENT]) {
      await changeNode(h, content);
      assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    }
  });

  test("an abort during a release verification answers routed, gives the tree back and leaves no release directory", async (t) => {
    const marker = join(temporary(t), MARKER);
    const h = await fixture(t, [], []);
    h.revision = {
      ...h.revision,
      content: {
        ...h.revision.content,
        verifications: [`touch ${marker}; sleep 30`],
      },
    };
    const reason = new Error(ABORTED);
    const gate = releaseGate(h);
    while (!existsSync(marker)) await delay(POLL_MS);
    h.run.operationContext.cancel(reason);
    assert.equal((await gate).kind, ReleaseGateKind.Routed);
    assert.equal(freeCommandTrees(h).length, ONE_TREE);
    assert.equal(existsSync(releaseKey(h)), false);
  });

  test("a release round after a new commit of the node tests the new head", async (t) => {
    const marker = join(temporary(t), MARKER);
    const h = await fixture(t, [], []);
    h.revision = {
      ...h.revision,
      content: {
        ...h.revision.content,
        verifications: [`git rev-parse HEAD >> ${marker}`],
      },
    };
    const heads: string[] = [];
    for (const content of ["changed", REVISED_CONTENT]) {
      await changeNode(h, content);
      heads.push(h.checkouts[0]!.head);
      assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
    }
    assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n"), heads);
  });
});

test("an affected command that reaches its time limit at the node head routes one revision to the node unit with the time limit and the output", async (t) => {
  const marker = join(temporary(t), "affected-started");
  const h = await fixture(t, [task("pass", "true")], []);
  await declareAffected(h, t, `touch ${marker}; echo hung-output; sleep 1000`);
  await commitOnNode(h.root, "changed");
  h.checkouts[0]!.head = (await simpleGit(h.root).revparse(["HEAD"])).trim();
  t.mock.method(
    h.agent.budget,
    "wallDeadline",
    () => Date.now() + 2 * COMMAND_LIMIT_MS,
  );
  const clock = commandLimitClock(t, marker);
  recordSpans(h, (batch) => clock.observe(batch));
  const gate = await releaseGate(h);
  await clock.elapsed();
  assert.ok(gate.kind === ReleaseGateKind.Routed);
  assert.equal(gate.unit.id, h.input.claim.node_id);
  assert.ok(gate.instruction.startsWith("Revise the task work"));
  assert.ok(
    gate.instruction.includes(
      `The affected tests reached their time limit of ${COMMAND_LIMIT_MS / 1000} s at ${h.checkouts[0]!.head}.`,
    ),
  );
  assert.ok(gate.instruction.includes("hung-output"));
});
