import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import { doneTrailerOf } from "./done-record.ts";
import { nodeUnitOf } from "./release-gate.ts";
import { EndReason, type ExecutionEnd } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import type { MethodClients } from "./method-clients.ts";
import { runStepsImplement, startCheck } from "./steps-implement.ts";
import type { WorkspaceCheckout } from "./workspace.ts";
import { NoProgressRule } from "./progress-rule.ts";
import { SpanOperation } from "./telemetry.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import {
  advanceBase,
  commitOnNode,
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture as fixture,
  NO_PROVIDER_CALLS,
  recordDone,
  recordReleases,
  task,
  TEST_SSH_ACCESS,
} from "./test-support.ts";

const VERDICT = "The edge case of an empty list stays unhandled.";
const CLEARED = "The verification host lost its network.";
const ONE_REVISION = 1;
const TWO_TURNS = 2;
const ONE_TURN = 1;
const PASSED_EXIT_CODE = 0;
const ONE_COMMAND = 1;
const TWO_TOOL_TURNS = 4;
const TWO_BINDINGS = ["api", "web"];
const BASE_FILE = "other";
const FETCH_DEADLINE_MS = 20000;
const SIDE_BRANCH = "side";
const FIRST_PARENT_FILE = "first-parent";
const ONE_RUN = 1;
const WALL_DEADLINE_MS = 300;

type Harness = Awaited<ReturnType<typeof fixture>>;

function verdictAt(text: string, checkouts: readonly WorkspaceCheckout[]) {
  return {
    text,
    judged: checkouts.map((checkout) => ({
      binding_id: checkout.binding_id,
      commit: checkout.head,
    })),
  };
}

function recordEvidence(h: Harness): string[][] {
  const commits: string[][] = [];
  h.run.clients.mission = {
    ...h.run.clients.mission,
    "evidence.submit": async (input: {
      body: { assets: { address: { commit: string } }[] };
    }) => {
      commits.push(input.body.assets.map((asset) => asset.address.commit));
      return { type: "completed", status: 200, data: { evidence: {} } };
    },
  } as unknown as MethodClients["mission"];
  return commits;
}

function occurrences(call: unknown, text: string): number {
  return JSON.stringify(call).split(text).length - ONE_TURN;
}

function write(path: string) {
  return fauxAssistantMessage(fauxToolCall("write", { path, content: path }), {
    stopReason: "toolUse",
  });
}

async function noProgressEnd(
  h: Harness,
): Promise<{ end: ExecutionEnd; bodies: unknown[]; evidence: string[][] }> {
  const bodies = recordReleases(h);
  const evidence = recordEvidence(h);
  const end = await executionBoundary(h.run, () => runStepsImplement(h));
  assert.ok("stop" in end && end.stop);
  assert.equal(end.stop.reason, EndReason.NoProgress);
  assert.equal(bodies.length, ONE_TURN);
  assert.deepEqual((bodies[0] as { further_work: boolean }).further_work, true);
  assert.deepEqual(evidence, []);
  return { end, bodies, evidence };
}

async function verdictHarness(
  t: TestContext,
  script: Parameters<typeof fixture>[2],
  names?: readonly string[],
) {
  const current = task("judged", "true");
  const h = await fixture(t, [current], script, undefined, names);
  await recordDone(h, current);
  return { h, current };
}

test("a verdict that names no task sends a verdict turn and an unchanged tree stops with no_progress", async (t) => {
  const { h, current } = await verdictHarness(t, [
    fauxAssistantMessage("nothing"),
    fauxAssistantMessage("nothing again"),
    fauxAssistantMessage("never"),
  ]);
  const judged = h.checkouts[0]!.head;
  h.verdict = verdictAt(VERDICT, h.checkouts);
  const starts = t.mock.method(h.run.spans, "start");
  const ends = t.mock.method(h.run.spans, "end");
  const { end } = await noProgressEnd(h);
  assert.ok("stop" in end && end.stop);
  assert.deepEqual(JSON.parse(end.stop.detail!), {
    rule: NoProgressRule.VerdictRuleUnmet,
    count: TWO_TURNS,
    limit: TWO_TURNS,
    verification: null,
  });
  const taskStart = starts.mock.calls.find(
    (call) => call.arguments[0].operation === SpanOperation.Task,
  );
  const taskEnd = ends.mock.calls.find(
    (call) => call.arguments[0] === taskStart?.result,
  );
  assert.deepEqual(taskEnd?.arguments[1], {
    status: SpanStatus.Error,
    attributes: {
      "kanthord.stop.reason": EndReason.NoProgress,
      "kanthord.stop.rule": NoProgressRule.VerdictRuleUnmet,
      "kanthord.stop.count": TWO_TURNS,
      "kanthord.stop.limit": TWO_TURNS,
      "kanthord.task.revision_count": ONE_REVISION,
    },
  });
  assert.equal(h.provider.calls.length, TWO_TURNS);
  const first = JSON.stringify(h.provider.calls[0]);
  assert.ok(first.includes(VERDICT));
  assert.ok(first.includes(current.id));
  assert.ok(first.includes("## Tasks"));
  assert.equal(occurrences(h.provider.calls[1], VERDICT), TWO_TURNS);
  assert.equal(h.checkouts[0]!.head, judged);
});

test("a verdict stop carries the passing verification of a task that ran before the verdict turns", async (t) => {
  const judgedTask = task("judged", "true");
  const pending = task("pending", "true && true");
  const h = await fixture(
    t,
    [judgedTask, pending],
    [
      fauxAssistantMessage("pending work"),
      fauxAssistantMessage("nothing"),
      fauxAssistantMessage("nothing again"),
      fauxAssistantMessage("never"),
    ],
  );
  await recordDone(h, judgedTask);
  h.verdict = verdictAt(VERDICT, h.checkouts);
  const { end } = await noProgressEnd(h);
  assert.ok("stop" in end && end.stop);
  assert.deepEqual(JSON.parse(end.stop.detail!), {
    rule: NoProgressRule.VerdictRuleUnmet,
    count: TWO_TURNS,
    limit: TWO_TURNS,
    verification: {
      passed: true,
      ran: ONE_COMMAND,
      exit_code: PASSED_EXIT_CODE,
      timed_out: false,
    },
  });
});

test("a base move between the review and the rework does not satisfy the verdict rule", async (t) => {
  const { h } = await verdictHarness(t, [
    fauxAssistantMessage("nothing"),
    fauxAssistantMessage("nothing again"),
    fauxAssistantMessage("never"),
  ]);
  const judged = h.checkouts[0]!.head;
  h.verdict = verdictAt(VERDICT, h.checkouts);
  await advanceBase(h, t, "moved base", BASE_FILE);
  await h.input.transport.fetchBase(
    h.root,
    "main",
    background,
    FETCH_DEADLINE_MS,
    TEST_SSH_ACCESS,
  );
  await noProgressEnd(h);
  assert.equal(h.provider.calls.length, TWO_TURNS);
  assert.notEqual(h.checkouts[0]!.head, judged);
  const parents = await simpleGit(h.root).raw([
    "rev-list",
    "--parents",
    "-n",
    "1",
    "HEAD",
  ]);
  assert.ok(parents.includes(judged));
});

test("an unblock with a cleared assessment and no needed change releases the same code", async (t) => {
  const { h } = await verdictHarness(t, [fauxAssistantMessage("nothing")]);
  const head = h.checkouts[0]!.head;
  h.cleared = CLEARED;
  recordReleases(h);
  const evidence = recordEvidence(h);
  assert.deepEqual(await executionBoundary(h.run, () => runStepsImplement(h)), {
    kind: "released",
    furtherWork: false,
  });
  assert.deepEqual(evidence, [[head]]);
  assert.equal(h.provider.calls.length, ONE_TURN);
  const call = JSON.stringify(h.provider.calls[0]);
  assert.ok(call.includes(CLEARED));
  assert.doesNotMatch(call, /Previous judgement/);
});

test("a verdict compares only the bindings that hold a judged commit", async (t) => {
  const { h } = await verdictHarness(
    t,
    [
      write("web/notes"),
      fauxAssistantMessage("web done"),
      write("api/notes"),
      fauxAssistantMessage("api done"),
      fauxAssistantMessage("never"),
    ],
    TWO_BINDINGS,
  );
  const [api, web] = h.checkouts;
  assert.ok(api && web);
  const judged = api.head;
  h.verdict = verdictAt(VERDICT, [api]);
  recordReleases(h);
  const evidence = recordEvidence(h);
  assert.deepEqual(await executionBoundary(h.run, () => runStepsImplement(h)), {
    kind: "released",
    furtherWork: false,
  });
  assert.equal(h.provider.calls.length, TWO_TOOL_TURNS);
  assert.notEqual(api.head, judged);
  assert.deepEqual(evidence, [[api.head, web.head]]);
});

test("a verdict turn that changes only a binding with no judged commit counts as unchanged", async (t) => {
  const { h } = await verdictHarness(
    t,
    [
      write("web/first"),
      fauxAssistantMessage("web done"),
      write("web/second"),
      fauxAssistantMessage("web done again"),
      fauxAssistantMessage("never"),
    ],
    TWO_BINDINGS,
  );
  h.verdict = verdictAt(VERDICT, [h.checkouts[0]!]);
  await noProgressEnd(h);
  assert.equal(h.provider.calls.length, TWO_TOOL_TURNS);
});

test("a verdict with no judged commit sends its text once and a pass completes the node unit", async (t) => {
  const { h } = await verdictHarness(t, [fauxAssistantMessage("nothing")]);
  const head = h.checkouts[0]!.head;
  h.verdict = verdictAt(VERDICT, []);
  recordReleases(h);
  const evidence = recordEvidence(h);
  assert.deepEqual(await executionBoundary(h.run, () => runStepsImplement(h)), {
    kind: "released",
    furtherWork: false,
  });
  assert.equal(h.provider.calls.length, ONE_TURN);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(VERDICT));
  assert.deepEqual(evidence, [[head]]);
});

test("a verdict with a later commit after its judged commit sends no verdict turn", async (t) => {
  const { h } = await verdictHarness(t, []);
  h.verdict = verdictAt(VERDICT, h.checkouts);
  await commitOnNode(h.root, "addressed");
  h.checkouts[0]!.head = (await simpleGit(h.root).revparse(["HEAD"])).trim();
  recordReleases(h);
  recordEvidence(h);
  assert.deepEqual(await executionBoundary(h.run, () => runStepsImplement(h)), {
    kind: "released",
    furtherWork: false,
  });
  assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
});

async function headOf(h: Harness): Promise<string> {
  const head = (await simpleGit(h.root).revparse(["HEAD"])).trim();
  h.checkouts[0]!.head = head;
  return head;
}

test("a rewritten node branch drops the judged commit and sends the verdict", async (t) => {
  const { h } = await verdictHarness(t, []);
  const base = h.checkouts[0]!.head;
  await commitOnNode(h.root, "judged");
  await headOf(h);
  h.verdict = verdictAt(VERDICT, h.checkouts);
  await simpleGit(h.root).raw(["reset", "--hard", base]);
  await commitOnNode(h.root, "rewritten");
  await headOf(h);
  const checked = await startCheck(h);
  assert.ok(checked.node?.text.includes(VERDICT));
  assert.deepEqual(checked.node?.judged, []);
});

test("a judged commit reached only through a second parent does not satisfy the verdict rule", async (t) => {
  const { h } = await verdictHarness(t, []);
  const git = simpleGit(h.root);
  await git.raw(["checkout", "-q", "-b", SIDE_BRANCH]);
  await commitOnNode(h.root, "judged");
  const judged = (await git.revparse(["HEAD"])).trim();
  await git.raw(["checkout", "-q", h.nodeBranch]);
  writeFileSync(join(h.root, FIRST_PARENT_FILE), FIRST_PARENT_FILE);
  await git.add(FIRST_PARENT_FILE);
  await git.commit(FIRST_PARENT_FILE);
  await git.raw(["merge", "--no-ff", "--no-edit", SIDE_BRANCH]);
  await git.raw(["branch", "-D", SIDE_BRANCH]);
  await headOf(h);
  h.verdict = {
    text: VERDICT,
    judged: [{ binding_id: h.checkouts[0]!.binding_id, commit: judged }],
  };
  const checked = await startCheck(h);
  assert.ok(checked.node?.text.includes(VERDICT));
  assert.deepEqual(
    checked.node?.judged.map((entry) => entry.commit),
    [judged],
  );
});

async function liveNodeHarness(
  t: TestContext,
  script: Parameters<typeof fixture>[2],
) {
  const count = join(temporary(t), "node");
  const node = `echo x >> ${count}`;
  const base = task("judged", node);
  const current = {
    ...base,
    content: { ...base.content, verifications: [node, "true"] },
  };
  const h = await fixture(t, [current], script);
  await recordDone(h, current);
  h.revision = {
    ...h.revision,
    content: { ...h.revision.content, verifications: [node] },
  };
  h.verdict = verdictAt(VERDICT, h.checkouts);
  return { h, count };
}

test("a verdict unit runs no node command in the live checkout", async (t) => {
  const { h, count } = await liveNodeHarness(t, [
    write("verdict"),
    fauxAssistantMessage("addressed"),
    fauxAssistantMessage("never"),
  ]);
  recordReleases(h);
  recordEvidence(h);
  assert.deepEqual(await executionBoundary(h.run, () => runStepsImplement(h)), {
    kind: "released",
    furtherWork: false,
  });
  assert.equal(readFileSync(count, "utf8").trim().split("\n").length, ONE_RUN);
});

test("a setup budget end before the empty list of a verdict unit writes no done record and releases further work", async (t) => {
  const { h, count } = await liveNodeHarness(t, [
    write("verdict"),
    fauxAssistantMessage("addressed"),
    fauxAssistantMessage("never"),
  ]);
  h.setup = h.setup.map((entry) => ({
    ...entry,
    environment: { postCreateCommand: "sleep 30" },
  }));
  h.setupPending = true;
  h.agent.budget.wallDeadline = () => Date.now() + WALL_DEADLINE_MS;
  const bodies = recordReleases(h);
  recordEvidence(h);
  const end = await executionBoundary(h.run, () => runStepsImplement(h));
  assert.ok("furtherWork" in end && end.furtherWork);
  assert.equal((bodies[0] as { further_work: boolean }).further_work, true);
  const log = await simpleGit(h.root).raw(["log", "--format=%B", h.nodeBranch]);
  assert.equal(
    log.includes(doneTrailerOf(nodeUnitOf(h.input.claim.node_id, h.revision))),
    false,
  );
  assert.equal(existsSync(count), false);
});
