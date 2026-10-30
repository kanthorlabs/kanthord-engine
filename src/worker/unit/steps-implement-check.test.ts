import assert from "node:assert/strict";
import { suite, test, type TestContext } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { SUITE_CONCURRENCY, temporary } from "../../kernel/test-support.ts";
import * as connector from "../../repository/connector.ts";
import { nodeBranchOf } from "../../repository/node-branch.ts";
import type { Revision } from "../../mission/contract.ts";
import type { scriptedProvider } from "./test-support.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
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
import { refreshAtClaim, RefreshResult } from "./base-refresh.ts";
import { MERGE_MARKERS_LEFT } from "./turn-gate.ts";
import { nodeUnitOf } from "./release-gate.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import {
  advanceBase,
  commitOnNode,
  implementFixture as fixture,
  NO_PROVIDER_CALLS,
  recordDone,
  recordReleases,
  task,
} from "./test-support.ts";

const MERGE_COMMIT_FIELDS = 3;
const MAIN_ADDITION = "added by main";
const RESOLVED = "resolved";
const DEADLINE_MS = 20000;
const RESTART_ATTEMPT = 2;
const RESTART_WORK = "restart work";
const STRAY_FILE = "stray.txt";
const ONE_RELEASE = 1;

suite("steps implement start check", { concurrency: SUITE_CONCURRENCY }, () => {
  test("the start check plans each task with no done record for its current content", async (t) => {
    const tasks = [
      task("open", "touch dirty; false"),
      task("done", "true"),
      task("revised", "true"),
    ];
    const h = await fixture(t, tasks, []);
    await recordDone(h, tasks[1]!);
    await recordDone(h, {
      ...tasks[2]!,
      content: { ...tasks[2]!.content, criterion: "earlier" },
    });
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
    assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
    assert.equal(existsSync(join(h.root, "dirty")), false);
    h.input.workspaces.release(
      h.input.workspaces.nodeKey(h.input.claim.node_id),
      WorkspaceKind.Node,
    );
  });

  test("a done record holds across start checks, and a verdict still goes to the node unit", async (t) => {
    const current = task("done", "true");
    const h = await fixture(t, [current], []);
    await recordDone(h, current);
    assert.deepEqual((await startCheck(h)).pending, []);
    assert.deepEqual((await startCheck(h)).pending, []);
    h.verdict = {
      text: `Unmet:\n- ${current.id}: still open`,
      judged: [],
    };
    const reworked = await startCheck(h);
    assert.deepEqual(reworked.pending, []);
    assert.ok(reworked.node?.text.includes(current.id));
    assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
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
    const h = await fixture(t, [current], []);
    await recordDone(h, current);
    h.verdict = {
      text: requested,
      judged: [
        {
          binding_id: h.checkouts[0]!.binding_id,
          commit: h.checkouts[0]!.head,
        },
      ],
    };
    const checked = await startCheck(h);
    assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
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
    for (const current of tasks) await recordDone(h, current);
    h.verdict = {
      text: "The route stays unhandled.",
      judged: [
        {
          binding_id: h.checkouts[0]!.binding_id,
          commit: h.checkouts[0]!.head,
        },
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
    const { h } = await verdictFixture(
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
    const latest = (await simpleGit(h.root).log()).latest!;
    assert.equal(latest.message, `feat: ${h.revision.content.name}`);
    assert.equal(latest.body.trim(), h.input.claim.node_id);
  });

  test("the start check of a verdict runs no node verification", async (t) => {
    const marker = join(temporary(t), "node-ran");
    const { h } = await verdictFixture(t, [], `touch ${marker}; false`);
    const events = t.mock.method(h.run, "log");
    assert.deepEqual((await startCheck(h)).pending, []);
    assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
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
    assert.equal(
      readFileSync(join(prepared.root, "file"), "utf8"),
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

  test("an implement node with no task plans the node unit until a done record matches the node content", async (t) => {
    const h = await fixture(t, [], []);
    h.revision = nodeUnitRevision("true");
    const nodeId = h.input.claim.node_id;
    assert.deepEqual(
      (await startCheck(h)).pending.map((pending) => pending.task.id),
      [nodeId],
    );
    await recordDone(h, nodeUnitOf(nodeId, h.revision));
    assert.deepEqual((await startCheck(h)).pending, []);
    h.revision = nodeUnitRevision("false");
    assert.deepEqual(
      (await startCheck(h)).pending.map((pending) => pending.task.id),
      [nodeId],
    );
    assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
  });
});
