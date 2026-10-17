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
} from "./test-support.ts";
import { EndReason, ExecutionRun, ExecutionStop } from "./execution-run.ts";
import {
  criterionRevisionInstruction,
  requestedChangesText,
} from "./judgement.ts";
import type { MethodClients } from "./method-clients.ts";
import { WorkspaceKind } from "./workspace.ts";
import { TaskBoundary } from "./steps-implement.ts";
import { prepareStepsWorkspace, startCheck } from "./steps-implement.ts";
import { RefreshResult, refreshAtClaim } from "./base-refresh.ts";
import { judgedAt } from "./judged-tasks.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import {
  advanceBase,
  commitOnNode,
  implementFixture as fixture,
  NO_PROVIDER_CALLS,
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
const CHOICE_AND_TWO_JUDGEMENTS = 3;
const THREE_JUDGEMENTS = 3;

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
      { task_id: tasks[1]!.id, commit: h.head, criterion_met: true },
      { task_id: tasks[2]!.id, commit: h.head, criterion_met: false },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(h.provider.calls[0]),
    /Previous judgement/,
  );
  assert.equal(h.provider.calls.length, PROVIDER_CALL_COUNT);
  assert.equal(existsSync(join(h.directory, "dirty")), false);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(tasks[1]!.id));
  assert.ok(JSON.stringify(h.provider.calls[1]).includes(tasks[2]!.id));
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(h.input.claim.node_id),
    WorkspaceKind.Node,
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
  h.priorRationale = `Unmet:\n- ${current.id}: still open`;
  const reworked = await startCheck(h);
  assert.deepEqual(
    reworked.pending.map((pending) => pending.task.id),
    [current.id],
  );
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

test("the start check revises a task that the prior rationale names without a judgement", async (t) => {
  const named = task("named", "true");
  const other = task("other", "true");
  const h = await fixture(
    t,
    [named, other],
    [
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  const rationale = `Two gaps\nUnmet:\n- ${named.id}: no route check`;
  h.priorRationale = rationale;
  const checked = await startCheck(h);
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(other.id));
  assert.deepEqual(checked.pending, [
    {
      task: named,
      boundary: "run_passed",
      instruction: criterionRevisionInstruction(SHIPPED_TEMPLATES, rationale),
    },
  ]);
});

test("the start check judges a task against the requested changes of a change request", async (t) => {
  const requested = requestedChangesText([
    {
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
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":false,"rationale":"unmet"}',
      ),
    ],
  );
  h.priorRationale = requested;
  const checked = await startCheck(h);
  const judgement = JSON.stringify(h.provider.calls[0]);
  assert.ok(judgement.includes("Reviewer octo requests changes"));
  assert.ok(judgement.includes("src/route.ts:4: Use /api."));
  assert.deepEqual(checked.pending, [
    {
      task: current,
      boundary: "run_passed",
      instruction: criterionRevisionInstruction(SHIPPED_TEMPLATES, requested),
    },
  ]);
});

const NODE_FAILURE = "regression in the foundation suite";
const MET = 'kanthord-judgement: {"criterion_met":true,"rationale":"met"}';

async function reworkFixture(
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
  h.rework = true;
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

test("the start check of a rework revises the chosen task when a node verification fails", async (t) => {
  const { h, tasks } = await reworkFixture(
    t,
    [
      fauxAssistantMessage('kanthord-judgement: {"filename":"second.md"}'),
      fauxAssistantMessage(MET),
      fauxAssistantMessage(MET),
    ],
    `echo ${NODE_FAILURE}; false`,
  );
  h.priorRationale = "Verification 1 `false` failed with exit code 1.";
  const events = t.mock.method(h.run, "log");
  const checked = await startCheck(h);
  assert.equal(checked.budgetEnd, null);
  assert.equal(checked.pending.length, ONE_JUDGEMENT);
  const [pending] = checked.pending;
  assert.equal(pending!.task, tasks[1]);
  assert.equal(pending!.boundary, TaskBoundary.RunPassed);
  assert.ok(pending!.instruction?.includes(NODE_FAILURE));
  assert.ok(pending!.instruction?.includes("the last 4 KiB"));
  const choice = JSON.stringify(h.provider.calls[0]);
  for (const current of tasks) assert.ok(choice.includes(current.filename));
  assert.ok(choice.includes(NODE_FAILURE));
  assert.equal(h.provider.calls.length, CHOICE_AND_TWO_JUDGEMENTS);
  assert.deepEqual(loggedFields(events, "task chosen"), [
    { task_id: tasks[1]!.id, commit: h.head, fallback: false },
  ]);
  assert.deepEqual(
    loggedFields(events, TASK_JUDGED).map(
      (fields) => (fields as { task_id: string }).task_id,
    ),
    [tasks[0]!.id, tasks[2]!.id],
  );
});

test("an invalid task choice of a rework falls back to the last task", async (t) => {
  const { h, tasks } = await reworkFixture(
    t,
    [
      fauxAssistantMessage('kanthord-judgement: {"filename":"missing.md"}'),
      fauxAssistantMessage(MET),
      fauxAssistantMessage(MET),
    ],
    `echo ${NODE_FAILURE}; false`,
  );
  const events = t.mock.method(h.run, "log");
  const checked = await startCheck(h);
  assert.deepEqual(
    checked.pending.map((pending) => pending.task.id),
    [tasks[2]!.id],
  );
  assert.ok(checked.pending[0]!.instruction?.includes(NODE_FAILURE));
  assert.deepEqual(loggedFields(events, "task chosen"), [
    { task_id: tasks[2]!.id, commit: h.head, fallback: true },
  ]);
});

test("the start check of a rework whose node verifications pass skips every task judged met", async (t) => {
  const { h } = await reworkFixture(
    t,
    [
      fauxAssistantMessage(MET),
      fauxAssistantMessage(MET),
      fauxAssistantMessage(MET),
    ],
    "true",
  );
  const events = t.mock.method(h.run, "log");
  assert.deepEqual((await startCheck(h)).pending, []);
  assert.equal(h.provider.calls.length, THREE_JUDGEMENTS);
  assert.deepEqual(loggedFields(events, "node verified"), [
    { commit: h.head, passed: true, exit_codes: [0] },
  ]);
  assert.deepEqual(loggedFields(events, "task chosen"), []);
});

test("the start check of an execution that is not a rework runs no node verification", async (t) => {
  const marker = join(temporary(t), "node-ran");
  const { h } = await reworkFixture(
    t,
    [
      fauxAssistantMessage(MET),
      fauxAssistantMessage(MET),
      fauxAssistantMessage(MET),
    ],
    `touch ${marker}; false`,
  );
  h.rework = false;
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
    h.directory,
    "main",
    background,
    DEADLINE_MS,
  );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.equal(readFileSync(join(h.directory, "other"), "utf8"), MAIN_ADDITION);
  const parents = await simpleGit(h.directory).raw([
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
                      commit: h.head,
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
  assert.deepEqual(
    { reason: run.stopOf(error).reason, code: run.stopOf(error).code },
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
  await simpleGit(h.directory).raw(["checkout", "-b", restartBranch]);
  await commitOnNode(h.directory, RESTART_WORK);
  const restartHead = (await simpleGit(h.directory).revparse(["HEAD"])).trim();
  await h.input.transport.pushNodeBranch(
    h.directory,
    restartBranch,
    background,
    DEADLINE_MS,
  );
  await advanceBase(h, t, MAIN_ADDITION, "other");
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(nodeId),
    WorkspaceKind.Node,
  );
  const prepared = await h.input.workspaces.prepareImplement({
    nodeId,
    nodeBranch: restartBranch,
    pushed: false,
    repository: h.input.setup.repositories[0]!,
    transport: h.input.transport,
    context: background,
    deadlineMs: DEADLINE_MS,
  });
  assert.equal(prepared.head, restartHead);
  assert.equal(
    (await simpleGit(prepared.directory).branch()).current,
    restartBranch,
  );
  const state = { ...h, ...prepared };
  assert.equal(await refreshAtClaim(state), RefreshResult.Merged);
  assert.equal(
    readFileSync(join(prepared.directory, "other"), "utf8"),
    MAIN_ADDITION,
  );
  assert.equal(
    readFileSync(join(prepared.directory, "file"), "utf8"),
    RESTART_WORK,
  );
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
  await commitOnNode(h.directory, "node side");
  await advanceBase(h, t, "main side");
  await h.input.transport.fetchBase(
    h.directory,
    "main",
    background,
    DEADLINE_MS,
  );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.equal(readFileSync(join(h.directory, "file"), "utf8"), RESOLVED);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes("conflicts"));
  assert.equal((await simpleGit(h.directory).status()).isClean(), true);
});

test("the claim refresh aborts the merge and stops when a conflict marker remains", async (t) => {
  const h = await fixture(
    t,
    [],
    [fauxAssistantMessage("I could not resolve it")],
  );
  h.revision = { content: NODE_CONTENT, tasks: [] } as unknown as Revision;
  await commitOnNode(h.directory, "node side");
  const before = await simpleGit(h.directory).revparse(["HEAD"]);
  await advanceBase(h, t, "main side");
  await h.input.transport.fetchBase(
    h.directory,
    "main",
    background,
    DEADLINE_MS,
  );
  await assert.rejects(refreshAtClaim(h), ExecutionStop);
  assert.equal(await simpleGit(h.directory).revparse(["HEAD"]), before);
  assert.equal((await simpleGit(h.directory).status()).isClean(), true);
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
    { task_id: nodeId, commit: h.head, criterion_met: true },
  ]);
  assert.equal(
    judgedAt(h.input.workspaces.nodeKey(nodeId), {
      attempt: h.input.claim.attempt,
      revision: h.input.claim.pinned_revision,
      taskId: nodeId,
    }),
    h.head,
  );
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(nodeId));
  h.revision = nodeUnitRevision("false");
  assert.deepEqual(
    (await startCheck(h)).pending.map((pending) => pending.task.id),
    [nodeId],
  );
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
});

test("a failed node verification sends no task-choice instruction", async (t) => {
  const h = await fixture(t, [], []);
  h.revision = nodeUnitRevision(`echo ${NODE_FAILURE}; false`);
  h.rework = true;
  const events = t.mock.method(h.run, "log");
  const checked = await startCheck(h);
  assert.equal(checked.budgetEnd, null);
  assert.deepEqual(
    checked.pending.map((pending) => pending.task.id),
    [h.input.claim.node_id],
  );
  assert.ok(checked.pending[0]!.instruction?.includes(NODE_FAILURE));
  assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
  assert.deepEqual(loggedFields(events, "task chosen"), []);
});
