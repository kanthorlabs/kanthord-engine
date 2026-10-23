import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { temporary } from "../../kernel/test-support.ts";
import type { Revision } from "../../mission/contract.ts";
import { executionBoundary } from "./native-method.ts";
import { JUDGEMENT_MARKER } from "./judgement.ts";
import { taskCommitMessage } from "./local-git.ts";
import type { MethodClients } from "./method-clients.ts";
import { runStepsImplement, startCheck } from "./steps-implement.ts";
import { nodeUnitOf } from "./release-gate.ts";
import { DONE_TRAILER, doneRecordOf } from "./done-record.ts";
import {
  advanceBase,
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture as fixture,
  nextExecution,
  NO_PROVIDER_CALLS,
  recordDone,
  recordReleases,
  task,
} from "./test-support.ts";

type Harness = Awaited<ReturnType<typeof fixture>>;

const ONE_TOOL_TURN = 2;
const TWO_TOOL_TURNS = 4;
const ONE_TURN = 1;
const TWO_TURNS = 2;
const TWO_BINDINGS = ["api", "web"];
const RELEASED = { kind: "released", furtherWork: false };
const BUDGET_END = "budget_end";
const SECOND_RUN_PASSES = "test -f .git/seen || { touch .git/seen; false; }";
const MET = `${JUDGEMENT_MARKER} {"criterion_met":true,"rationale":"met"}`;

const write = (path: string) =>
  fauxAssistantMessage(fauxToolCall("write", { path, content: path }), {
    stopReason: "toolUse",
  });

const bash = (command: string) =>
  fauxAssistantMessage(fauxToolCall("bash", { command }), {
    stopReason: "toolUse",
  });

function endAfterTurn(h: Harness, last: number): void {
  let turns = 0;
  const prompt = h.agent.prompt.bind(h.agent);
  const instruct = h.agent.instruct.bind(h.agent);
  const count = () => {
    if (++turns >= last) h.agent.budget.exhausted = () => true;
  };
  h.agent.prompt = async (work) => {
    await prompt(work);
    count();
  };
  h.agent.instruct = async (work, text) => {
    await instruct(work, text);
    count();
  };
}

async function remoteRecords(h: Harness, bare = h.bare): Promise<string[]> {
  const output = await simpleGit(bare).raw([
    "log",
    `--format=%(trailers:key=${DONE_TRAILER},valueonly)`,
    `main..refs/heads/${h.nodeBranch}`,
  ]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function recordFinish(h: Harness): unknown[] {
  h.run.clients.mission = {
    ...h.run.clients.mission,
    "evidence.submit": async () => ({
      type: "completed",
      status: 200,
      data: { evidence: {} },
    }),
  } as unknown as MethodClients["mission"];
  return recordReleases(h);
}

function heldMarker(h: Harness): boolean {
  return h.provider.calls.some((call) =>
    JSON.stringify(call).includes(JUDGEMENT_MARKER),
  );
}

test("a budget end after task 1 leaves its done record, and the next execution runs only task 2", async (t) => {
  const first = task("alpha-unit", "test -f first");
  const second = task("beta-unit", "test -f second");
  const h = await fixture(
    t,
    [first, second],
    [
      write("first"),
      fauxAssistantMessage("first done"),
      write("second"),
      fauxAssistantMessage("second partial"),
    ],
  );
  endAfterTurn(h, TWO_TURNS);
  const bodies = recordFinish(h);
  assert.deepEqual(await executionBoundary(h.run, () => runStepsImplement(h)), {
    kind: "released",
    furtherWork: true,
  });
  assert.deepEqual(bodies, [{ further_work: true, stop: null }]);
  assert.deepEqual(await remoteRecords(h), [doneRecordOf(first)]);
  const subjects = await simpleGit(h.bare).raw([
    "log",
    "--format=%s",
    `--grep=${DONE_TRAILER}`,
    `refs/heads/${h.nodeBranch}`,
  ]);
  assert.equal(
    subjects.trim(),
    taskCommitMessage(first.id, h.input.claim.attempt),
  );
  const next = await nextExecution(t, h, [
    write("second"),
    fauxAssistantMessage("second done"),
  ]);
  recordFinish(next);
  assert.deepEqual(
    await executionBoundary(next.run, () => runStepsImplement(next)),
    RELEASED,
  );
  assert.equal(next.provider.calls.length, ONE_TOOL_TURN);
  const call = JSON.stringify(next.provider.calls[0]);
  assert.ok(call.includes(second.content.name));
  assert.equal(call.includes(first.content.name), false);
});

test("a task whose verifications pass on the base still gets a work turn", async (t) => {
  const current = task("passing-unit", "true");
  const h = await fixture(t, [current], [fauxAssistantMessage("nothing")]);
  recordFinish(h);
  assert.deepEqual(
    await executionBoundary(h.run, () => runStepsImplement(h)),
    RELEASED,
  );
  assert.equal(h.provider.calls.length, ONE_TURN);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(current.content.name));
  assert.equal(heldMarker(h), false);
});

test("an implement execution runs no answer turn", async (t) => {
  const current = task("revised", "grep -q good file");
  const h = await fixture(
    t,
    [current],
    [
      bash("echo bad > file"),
      fauxAssistantMessage("first"),
      bash("echo good > file"),
      fauxAssistantMessage("second"),
    ],
  );
  recordFinish(h);
  assert.deepEqual(
    await executionBoundary(h.run, () => runStepsImplement(h)),
    RELEASED,
  );
  assert.equal(h.provider.calls.length, TWO_TOOL_TURNS);
  assert.equal(heldMarker(h), false);
  assert.deepEqual(await remoteRecords(h), [doneRecordOf(current)]);
});

test("a task that passes with no change writes no record, and a budget end then releases the budget_end stop", async (t) => {
  const first = task("first", SECOND_RUN_PASSES);
  const second = task("second-unit", "false");
  const h = await fixture(
    t,
    [first, second],
    [
      fauxAssistantMessage("nothing"),
      fauxAssistantMessage(MET),
      fauxAssistantMessage("partial"),
    ],
  );
  const prompt = h.agent.prompt.bind(h.agent);
  h.agent.prompt = async (work) => {
    await prompt(work);
    if (JSON.stringify(work).includes(second.content.name))
      h.agent.budget.exhausted = () => true;
  };
  const bodies = recordFinish(h);
  const end = await executionBoundary(h.run, () => runStepsImplement(h));
  assert.ok("stop" in end && end.stop);
  assert.equal(end.stop.reason, BUDGET_END);
  assert.equal(end.furtherWork, true);
  assert.equal(bodies.length, ONE_TURN);
  assert.deepEqual(await remoteRecords(h), []);
});

test("a task that changes only checkout B runs no turn in the next execution", async (t) => {
  const current = task("web-change", "test -f web/added");
  const h = await fixture(
    t,
    [current],
    [write("web/added"), fauxAssistantMessage("done")],
    undefined,
    TWO_BINDINGS,
  );
  recordFinish(h);
  assert.deepEqual(
    await executionBoundary(h.run, () => runStepsImplement(h)),
    RELEASED,
  );
  const [apiBare, webBare] = h.bares;
  assert.deepEqual(await remoteRecords(h, apiBare), []);
  assert.deepEqual(await remoteRecords(h, webBare), [doneRecordOf(current)]);
  const next = await nextExecution(t, h, []);
  recordFinish(next);
  assert.deepEqual(
    await executionBoundary(next.run, () => runStepsImplement(next)),
    RELEASED,
  );
  assert.equal(next.provider.calls.length, NO_PROVIDER_CALLS);
});

test("a task commit that fails its verification writes no record, and the next execution runs a turn for it", async (t) => {
  const current = task("good-unit", "test -f good");
  const h = await fixture(
    t,
    [current],
    [
      write("bad"),
      fauxAssistantMessage("bad done"),
      fauxAssistantMessage("partial"),
    ],
  );
  endAfterTurn(h, TWO_TURNS);
  recordFinish(h);
  const end = await executionBoundary(h.run, () => runStepsImplement(h));
  assert.ok("furtherWork" in end && end.furtherWork);
  assert.deepEqual(await remoteRecords(h), []);
  const next = await nextExecution(t, h, [
    write("good"),
    fauxAssistantMessage("good done"),
  ]);
  recordFinish(next);
  assert.deepEqual(
    await executionBoundary(next.run, () => runStepsImplement(next)),
    RELEASED,
  );
  assert.equal(next.provider.calls.length, ONE_TOOL_TURN);
  assert.ok(
    JSON.stringify(next.provider.calls[0]).includes(current.content.name),
  );
});

test("a done trailer in an agent commit message does not survive the gate", async (t) => {
  const current = task("forged", "test -f good");
  const h = await fixture(
    t,
    [current],
    [
      bash(
        `echo forged > file && git commit -qam forged --trailer "${DONE_TRAILER}: ${doneRecordOf(current)}"`,
      ),
      fauxAssistantMessage("committed"),
      fauxAssistantMessage("partial"),
    ],
  );
  endAfterTurn(h, TWO_TURNS);
  recordFinish(h);
  await executionBoundary(h.run, () => runStepsImplement(h));
  assert.deepEqual(await remoteRecords(h), []);
  const messages = await simpleGit(h.bare).raw([
    "log",
    "--format=%B",
    `main..refs/heads/${h.nodeBranch}`,
  ]);
  assert.equal(messages.includes("forged"), false);
});

const VERDICT = "The edge case of an empty list stays unhandled.";
const REVISED_CRITERION = "The second unit holds a revised criterion.";
const BASE_FILE = "other";
const MERGE_COMMIT_FIELDS = 3;

function nodeRevision(h: Harness, command: string): Revision {
  return {
    ...h.revision,
    tasks: [],
    content: { ...h.revision.content, verifications: [command] },
  };
}

function verdictAtHead(h: Harness) {
  return {
    text: VERDICT,
    judged: h.checkouts.map((checkout) => ({
      binding_id: checkout.binding_id,
      commit: checkout.head,
    })),
  };
}

test("a verdict unit that passes counts as completed when the budget ends in the release gate", async (t) => {
  const markers = temporary(t);
  const live = join(markers, "live");
  const release = join(markers, "release");
  const h = await fixture(
    t,
    [],
    [write("addressed"), fauxAssistantMessage("addressed")],
  );
  h.revision = nodeRevision(
    h,
    `if [ -f ${live} ]; then touch ${release}; else touch ${live}; fi`,
  );
  await recordDone(h, nodeUnitOf(h.input.claim.node_id, h.revision));
  h.verdict = verdictAtHead(h);
  h.agent.budget.exhausted = () => existsSync(release);
  const bodies = recordFinish(h);
  assert.deepEqual(await executionBoundary(h.run, () => runStepsImplement(h)), {
    kind: "released",
    furtherWork: true,
  });
  assert.deepEqual(bodies, [{ further_work: true, stop: null }]);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(VERDICT));
});

test("a change to one task content reopens only that task in the next execution", async (t) => {
  const first = task("alpha-unit", "test -f first");
  const second = task("beta-unit", "test -f second");
  const h = await fixture(
    t,
    [first, second],
    [
      write("first"),
      fauxAssistantMessage("first done"),
      write("second"),
      fauxAssistantMessage("second done"),
    ],
  );
  recordFinish(h);
  assert.deepEqual(
    await executionBoundary(h.run, () => runStepsImplement(h)),
    RELEASED,
  );
  const revised = {
    ...second,
    content: { ...second.content, criterion: REVISED_CRITERION },
  };
  const next = await nextExecution(
    t,
    { ...h, revision: { ...h.revision, tasks: [first, revised] } },
    [fauxAssistantMessage("nothing")],
  );
  recordFinish(next);
  assert.deepEqual(
    await executionBoundary(next.run, () => runStepsImplement(next)),
    RELEASED,
  );
  assert.equal(next.provider.calls.length, ONE_TURN);
  const call = JSON.stringify(next.provider.calls[0]);
  assert.ok(call.includes(REVISED_CRITERION));
  assert.equal(call.includes(first.content.name), false);
});

test("done records survive a base move and the template merge", async (t) => {
  const current = task("merged-unit", "test -f merged");
  const h = await fixture(
    t,
    [current],
    [write("merged"), fauxAssistantMessage("done")],
  );
  recordFinish(h);
  assert.deepEqual(
    await executionBoundary(h.run, () => runStepsImplement(h)),
    RELEASED,
  );
  await advanceBase(h, t, "moved base", BASE_FILE);
  const next = await nextExecution(t, h, []);
  recordFinish(next);
  assert.deepEqual(
    await executionBoundary(next.run, () => runStepsImplement(next)),
    RELEASED,
  );
  assert.equal(next.provider.calls.length, NO_PROVIDER_CALLS);
  const parents = await simpleGit(next.root).raw([
    "rev-list",
    "--parents",
    "-n",
    "1",
    "HEAD",
  ]);
  assert.equal(parents.trim().split(" ").length, MERGE_COMMIT_FIELDS);
});

test("a rework of a node that holds a node record still sends the verdict", async (t) => {
  const h = await fixture(t, [], []);
  h.revision = nodeRevision(h, "true");
  await recordDone(h, nodeUnitOf(h.input.claim.node_id, h.revision));
  h.verdict = verdictAtHead(h);
  const checked = await startCheck(h);
  assert.deepEqual(checked.pending, []);
  assert.ok(checked.node?.text.includes(VERDICT));
});
