import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import * as connector from "../../repository/connector.ts";
import { nodeBranchOf } from "../../repository/node-branch.ts";
import type { Revision } from "../../mission/contract.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  scriptedProvider,
  TEST_SSH_ACCESS,
} from "./test-support.ts";
import {
  EndReason,
  ExecutionEndKind,
  ExecutionRun,
  ExecutionStop,
} from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import {
  criterionRevisionInstruction,
  requestedChangesText,
} from "./judgement.ts";
import type { MethodClients } from "./method-clients.ts";
import { WorkspaceKind } from "./workspace.ts";
import {
  prepareStepsWorkspace,
  runStepsImplement,
  startCheck,
} from "./steps-implement.ts";
import { RefreshResult, refreshAtClaim } from "./base-refresh.ts";
import { MERGE_MARKERS_LEFT } from "./turn-gate.ts";
import { headSetOf, judgedAt, recordJudged } from "./judged-tasks.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import {
  advanceBase,
  commitOnNode,
  implementFixture as fixture,
  recordReleases,
  task,
} from "./test-support.ts";

const PROVIDER_CALL_COUNT = 2;
const ONE_JUDGEMENT = 1;
const MERGE_COMMIT_FIELDS = 3;
const MAIN_ADDITION = "added by main";
const RESOLVED = "resolved";
const DEADLINE_MS = 20000;
const RESTART_ATTEMPT = 2;
const RESTART_WORK = "restart work";
const SECOND_JUDGEMENT = 2;
const TASK_JUDGED = "task judged";
const THREE_JUDGEMENTS = 3;
const STRAY_FILE = "stray.txt";
const ONE_RELEASE = 1;

test("start check judges passing tasks in order and discards verification changes", async (t) => {
  const tasks = [
    task("failed", "touch dirty; false"),
    task("met", "true"),
    task("unmet", "true"),
  ];
  const h = await fixture(t, tasks, [
    fauxAssistantMessage(
      'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
    ),
    fauxAssistantMessage(
      'kanthord-judgement: {"criterion_met":false,"rationale":"unmet"}',
    ),
  ]);
  const events = t.mock.method(h.run, "log");
  assert.deepEqual(
    (await startCheck(h)).pending.map(({ task, instruction }) => [
      task.id,
      instruction,
    ]),
    [
      [tasks[0]!.id, null],
      [tasks[2]!.id, null],
    ],
  );
  assert.deepEqual(
    events.mock.calls
      .filter((call) => call.arguments[0] === TASK_JUDGED)
      .map((call) => call.arguments[1]),
    [
      {
        task_id: tasks[1]!.id,
        commit: h.checkouts[0]!.head,
        criterion_met: true,
      },
      {
        task_id: tasks[2]!.id,
        commit: h.checkouts[0]!.head,
        criterion_met: false,
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(h.provider.calls[0]),
    /Previous judgement/,
  );
  assert.equal(h.provider.calls.length, PROVIDER_CALL_COUNT);
  assert.equal(existsSync(join(h.root, "dirty")), false);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(tasks[1]!.id));
  assert.ok(JSON.stringify(h.provider.calls[1]).includes(tasks[2]!.id));
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(h.input.claim.node_id),
    WorkspaceKind.Node,
  );
});

test("a start-check judgement that changes files commits them and leaves the task pending", async (t) => {
  const current = task("judged", "true");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: STRAY_FILE, content: "stray" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  const base = h.checkouts[0]!.head;
  assert.deepEqual(
    (await startCheck(h)).pending.map(({ task, instruction }) => [
      task.id,
      instruction,
    ]),
    [[current.id, null]],
  );
  assert.notEqual(h.checkouts[0]!.head, base);
  assert.equal(
    (await simpleGit(h.root).raw(["ls-files", STRAY_FILE])).trim(),
    STRAY_FILE,
  );
  assert.equal(
    judgedAt(h.input.workspaces.nodeKey(h.input.claim.node_id), {
      attempt: h.input.claim.attempt,
      revision: h.input.claim.pinned_revision,
      taskId: current.id,
    }),
    null,
  );
});

test("the start check repairs one invalid judgement and stops on two", async (t) => {
  const repaired = await fixture(
    t,
    [task("met", "true")],
    [
      fauxAssistantMessage("no judgement"),
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  assert.deepEqual((await startCheck(repaired)).pending, []);
  assert.equal(repaired.provider.calls.length, PROVIDER_CALL_COUNT);
  const invalid = await fixture(
    t,
    [task("met", "true")],
    [
      fauxAssistantMessage("no judgement"),
      fauxAssistantMessage("still no judgement"),
    ],
  );
  await assert.rejects(startCheck(invalid), {
    reason: EndReason.JudgementInvalid,
  });
});

test("the start check skips the judgement of a task judged met at the current head", async (t) => {
  const current = task("judged", "true");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  assert.deepEqual((await startCheck(h)).pending, []);
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
  assert.deepEqual((await startCheck(h)).pending, []);
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
  h.verdict = {
    text: `Unmet:\n- ${current.id}: still open`,
    judged: [],
  };
  const reworked = await startCheck(h);
  assert.deepEqual(reworked.pending, []);
  assert.ok(reworked.node?.text.includes(current.id));
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
});

test("the start check does not reuse a judgement of the previous attempt", async (t) => {
  const current = task("judged", "true");
  const met = fauxAssistantMessage(
    'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
  );
  const h = await fixture(t, [current], [met, met]);
  assert.deepEqual((await startCheck(h)).pending, []);
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
  h.input.claim.attempt = RESTART_ATTEMPT;
  assert.deepEqual((await startCheck(h)).pending, []);
  assert.equal(h.provider.calls.length, SECOND_JUDGEMENT);
});

test("the start check sends the requested changes to the node unit and not to a task judgement", async (t) => {
  const requested = requestedChangesText([
    {
      binding: "repo",
      head_commit: "a".repeat(40),
      change_requests: [
        {
          review_id: 7,
          reviewer: "octo",
          body: "Rename the route.",
          submitted_at: null,
          commit_id: "a".repeat(40),
          comments: [{ path: "src/route.ts", line: 4, body: "Use /api." }],
        },
      ],
    },
  ]);
  assert.ok(requested);
  const current = task("review", "true");
  const h = await fixture(t, [current], [fauxAssistantMessage(MET)]);
  h.verdict = {
    text: requested,
    judged: [
      { binding_id: h.checkouts[0]!.binding_id, commit: h.checkouts[0]!.head },
    ],
  };
  const checked = await startCheck(h);
  assert.doesNotMatch(
    JSON.stringify(h.provider.calls[0]),
    /Reviewer octo requests changes/,
  );
  assert.deepEqual(checked.pending, []);
  assert.equal(
    checked.node?.text,
    criterionRevisionInstruction(SHIPPED_TEMPLATES, requested),
  );
  assert.deepEqual(
    checked.node?.judged.map((entry) => entry.commit),
    [h.checkouts[0]!.head],
  );
});

const MET = 'kanthord-judgement: {"criterion_met":true,"rationale":"met"}';

async function verdictFixture(
  t: TestContext,
  script: Parameters<typeof scriptedProvider>[0],
  nodeCommand: string,
) {
  const tasks = [
    task("first", "true"),
    task("second", "true"),
    task("third", "true"),
  ];
  const h = await fixture(t, tasks, script);
  h.revision = {
    tasks,
    content: { ...NODE_CONTENT, verifications: [nodeCommand] },
  } as unknown as Revision;
  h.verdict = {
    text: "The route stays unhandled.",
    judged: [
      { binding_id: h.checkouts[0]!.binding_id, commit: h.checkouts[0]!.head },
    ],
  };
  return { h, tasks };
}

function loggedFields(
  events: { mock: { calls: { arguments: unknown[] }[] } },
  message: string,
) {
  return events.mock.calls
    .filter((call) => call.arguments[0] === message)
    .map((call) => call.arguments[1]);
}

test("a budget end in the verdict turn commits its files as a checkpoint", async (t) => {
  const { h, tasks } = await verdictFixture(
    t,
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: STRAY_FILE, content: "stray" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("written"),
    ],
    "true",
  );
  for (const current of tasks)
    recordJudged(
      h.input.workspaces.nodeKey(h.input.claim.node_id),
      {
        attempt: h.input.claim.attempt,
        revision: h.input.claim.pinned_revision,
        taskId: current.id,
      },
      headSetOf(h.checkouts),
    );
  const instruct = h.agent.instruct.bind(h.agent);
  h.agent.instruct = async (...args) => {
    await instruct(...args);
    h.agent.budget.exhausted = () => true;
  };
  const bodies = recordReleases(h);
  const end = await executionBoundary(h.run, () => runStepsImplement(h));
  assert.ok(end.kind === ExecutionEndKind.Released && end.furtherWork);
  assert.equal(bodies.length, ONE_RELEASE);
  assert.equal(
    (await simpleGit(h.root).raw(["ls-files", STRAY_FILE])).trim(),
    STRAY_FILE,
  );
  const latest = (await simpleGit(h.root).log()).latest!.message;
  assert.ok(latest.includes("checkpoint"));
  assert.ok(latest.includes(h.input.claim.node_id));
});

test("the start check of a verdict runs no node verification", async (t) => {
  const marker = join(temporary(t), "node-ran");
  const { h } = await verdictFixture(
    t,
    [
      fauxAssistantMessage(MET),
      fauxAssistantMessage(MET),
      fauxAssistantMessage(MET),
    ],
    `touch ${marker}; false`,
  );
  const events = t.mock.method(h.run, "log");
  assert.deepEqual((await startCheck(h)).pending, []);
  assert.equal(h.provider.calls.length, THREE_JUDGEMENTS);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(loggedFields(events, "node verified"), []);
});

const NODE_CONTENT = {
  name: "node",
  requirement: "node",
  criterion: "node",
  verifications: ["true"],
  bindings: [],
};

test("the claim refresh merges a moved base branch without a conflict", async (t) => {
  const h = await fixture(t, [], []);
  await advanceBase(h, t, MAIN_ADDITION, "other");
  await h.input.transport.fetchBase(
    h.root,
    "main",
    background,
    DEADLINE_MS,
    TEST_SSH_ACCESS,
  );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.equal(readFileSync(join(h.root, "other"), "utf8"), MAIN_ADDITION);
  const parents = await simpleGit(h.root).raw([
    "rev-list",
    "--parents",
    "-n",
    "1",
    "HEAD",
  ]);
  assert.equal(parents.trim().split(" ").length, MERGE_COMMIT_FIELDS);
  assert.equal(await refreshAtClaim(h), RefreshResult.Current);
});

test("repository evidence of the attempt stops the preparation when the node branch is gone", async (t) => {
  const h = await fixture(t, [], []);
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(h.input.claim.node_id),
    WorkspaceKind.Node,
  );
  const run = new ExecutionRun({
    claim: h.input.claim,
    clients: {
      mission: {
        "execution.evidence.list": async () => ({
          type: "completed",
          status: 200,
          data: {
            items: [
              {
                assets: [
                  {
                    kind: "repository",
                    address: {
                      kind: "repository",
                      binding_id: h.input.setup.repositories[0]!.binding_id,
                      commit: h.checkouts[0]!.head,
                    },
                  },
                ],
              },
            ],
            next_cursor: null,
          },
        }),
      },
    } as unknown as MethodClients,
    credentials: { release: async () => {} },
    context: background,
  });
  t.after(() => run.dispose());
  const error = await prepareStepsWorkspace(h.input, run).then(
    () => assert.fail("The preparation must stop."),
    (error: unknown) => error,
  );
  const stopped = await run.stopOf(error);
  assert.deepEqual(
    { reason: stopped.reason, code: stopped.code },
    {
      reason: EndReason.OperationFailed,
      code: connector.NODE_BRANCH_MISSING,
    },
  );
});

test("an attempt that continues a restart branch checks out that branch and merges the moved base", async (t) => {
  const h = await fixture(t, [], []);
  const nodeId = h.input.claim.node_id;
  const restartBranch = nodeBranchOf(nodeId, RESTART_ATTEMPT);
  await simpleGit(h.root).raw(["checkout", "-b", restartBranch]);
  await commitOnNode(h.root, RESTART_WORK);
  const restartHead = (await simpleGit(h.root).revparse(["HEAD"])).trim();
  await h.input.transport.pushNodeBranch(
    h.root,
    restartBranch,
    background,
    DEADLINE_MS,
    TEST_SSH_ACCESS,
  );
  await advanceBase(h, t, MAIN_ADDITION, "other");
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(nodeId),
    WorkspaceKind.Node,
  );
  const prepared = await h.input.workspaces.prepareImplement({
    nodeId,
    nodeBranch: restartBranch,
    pushed: new Set(),
    repositories: h.input.setup.repositories,
    transport: h.input.transport,
    sshAccess: h.input.sshAccess,
    context: background,
    deadlineMs: DEADLINE_MS,
  });
  assert.equal(prepared.checkouts[0]!.head, restartHead);
  assert.equal(
    (await simpleGit(prepared.root).branch()).current,
    restartBranch,
  );
  const state = { ...h, ...prepared };
  assert.equal(await refreshAtClaim(state), RefreshResult.Merged);
  assert.equal(
    readFileSync(join(prepared.root, "other"), "utf8"),
    MAIN_ADDITION,
  );
  assert.equal(readFileSync(join(prepared.root, "file"), "utf8"), RESTART_WORK);
});

test("the claim refresh lets the agent resolve a merge conflict and commits the merge", async (t) => {
  const h = await fixture(
    t,
    [],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: "file", content: RESOLVED }),
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("resolved"),
    ],
  );
  h.revision = { content: NODE_CONTENT, tasks: [] } as unknown as Revision;
  await commitOnNode(h.root, "node side");
  h.checkouts[0]!.head = (await simpleGit(h.root).revparse(["HEAD"])).trim();
  await advanceBase(h, t, "main side");
  await h.input.transport.fetchBase(
    h.root,
    "main",
    background,
    DEADLINE_MS,
    TEST_SSH_ACCESS,
  );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.equal(readFileSync(join(h.root, "file"), "utf8"), RESOLVED);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes("conflicts"));
  assert.equal((await simpleGit(h.root).status()).isClean(), true);
});

test("the claim refresh aborts the merge and stops when a conflict marker remains", async (t) => {
  const h = await fixture(
    t,
    [],
    [fauxAssistantMessage("I could not resolve it")],
  );
  h.revision = { content: NODE_CONTENT, tasks: [] } as unknown as Revision;
  await commitOnNode(h.root, "node side");
  const before = await simpleGit(h.root).revparse(["HEAD"]);
  h.checkouts[0]!.head = before;
  await advanceBase(h, t, "main side");
  await h.input.transport.fetchBase(
    h.root,
    "main",
    background,
    DEADLINE_MS,
    TEST_SSH_ACCESS,
  );
  await assert.rejects(
    refreshAtClaim(h),
    (error: unknown) =>
      error instanceof ExecutionStop &&
      error.reason === EndReason.OperationFailed &&
      error.code === MERGE_MARKERS_LEFT,
  );
  assert.equal(await simpleGit(h.root).revparse(["HEAD"]), before);
  assert.equal((await simpleGit(h.root).status()).isClean(), true);
});

function nodeUnitRevision(command: string): Revision {
  return {
    filename: "implement.md",
    content: { ...NODE_CONTENT, verifications: [command] },
    tasks: [],
  } as unknown as Revision;
}

test("an implement node with no task runs the node verifications under the node identity as the judged key", async (t) => {
  const h = await fixture(t, [], [fauxAssistantMessage(MET)]);
  h.revision = nodeUnitRevision("true");
  const nodeId = h.input.claim.node_id;
  const events = t.mock.method(h.run, "log");
  assert.deepEqual((await startCheck(h)).pending, []);
  assert.deepEqual(loggedFields(events, TASK_JUDGED), [
    { task_id: nodeId, commit: h.checkouts[0]!.head, criterion_met: true },
  ]);
  assert.equal(
    judgedAt(h.input.workspaces.nodeKey(nodeId), {
      attempt: h.input.claim.attempt,
      revision: h.input.claim.pinned_revision,
      taskId: nodeId,
    }),
    h.checkouts[0]!.head,
  );
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(nodeId));
  h.revision = nodeUnitRevision("false");
  assert.deepEqual(
    (await startCheck(h)).pending.map((pending) => pending.task.id),
    [nodeId],
  );
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
});
