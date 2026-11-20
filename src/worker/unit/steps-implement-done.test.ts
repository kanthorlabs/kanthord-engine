import { VerdictSource } from "./node-verdict.ts";
import assert from "node:assert/strict";
import { suite, test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { SUITE_CONCURRENCY, temporary } from "../../kernel/test-support.ts";
import type { Revision } from "../../mission/contract.ts";
import { executionBoundary } from "./native-method.ts";
import { JUDGEMENT_MARKER } from "./judgement.ts";
import type { MethodClients } from "./method-clients.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { runStepsImplement } from "./steps-implement-host.ts";
import { nodeUnitOf } from "./release-gate.ts";
import { digest } from "../../kernel/json.ts";
import {
  advanceBase,
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture as fixture,
  nextExecution,
  NO_PROVIDER_CALLS,
  recordReleases,
  recordUnit,
  releasedRoot,
  task,
} from "./test-support.ts";

type Harness = Awaited<ReturnType<typeof fixture>>;

const ONE_TOOL_TURN = 2;
const ONE_TURN = 1;
const TWO_TURNS = 2;
const TWO_BINDINGS = ["api", "web"];
const RELEASED = { kind: "released", furtherWork: false };
const BUDGET_END = "budget_end";
const REVOKED = "revoked";
const NOT_RUNNING = "scheduler.execution.not_running";
const UNAVAILABLE = "worker.test.unavailable";
const FOREIGN_COMMIT = "f".repeat(40);
const REBUILT_SUFFIX = "-a2";
const SECOND_RUN_PASSES = "test -f .git/seen || { touch .git/seen; false; }";
const MET = `${JUDGEMENT_MARKER} {"criterion_met":true,"rationale":"met"}`;

const write = (path: string) =>
  fauxAssistantMessage(fauxToolCall("write", { path, content: path }), {
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
  h.agent.instruct = async (work, text, template) => {
    await instruct(work, text, template);
    count();
  };
}

function recordedUnits(h: Harness): string[] {
  return h.input.setup.unit_records.map(({ unit_id }) => unit_id);
}

function refusePut(h: Harness, status: number, code: string): void {
  h.run.clients.worker = {
    ...h.run.clients.worker,
    "execution.unit_record.put": async () => ({
      type: "failure",
      status,
      error: { error: { code, message: code, details: null }, request_id: "t" },
    }),
  } as unknown as MethodClients["worker"];
}

function logged(h: Harness): string[] {
  const messages: string[] = [];
  const log = h.run.log.bind(h.run);
  h.run.log = (message, fields) => {
    messages.push(message);
    log(message, fields);
  };
  return messages;
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

suite(
  "steps implement unit records",
  { concurrency: SUITE_CONCURRENCY },
  () => {
    test("a budget end after task 1 leaves its unit record, counts task 1 as completed, and the next execution runs only task 2", async (t) => {
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
      assert.deepEqual(
        await executionBoundary(h.run, () => runStepsImplement(h)),
        {
          kind: "released",
          furtherWork: true,
        },
      );
      assert.deepEqual(bodies, [{ further_work: true, stop: null }]);
      assert.deepEqual(recordedUnits(h), [first.id]);
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

    test("a task that passes with no change logs unit record skipped and counts as not completed, and a budget end then releases the budget_end stop", async (t) => {
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
      const messages = logged(h);
      const end = await executionBoundary(h.run, () => runStepsImplement(h));
      assert.ok("stop" in end && end.stop);
      assert.equal(end.stop.reason, BUDGET_END);
      assert.equal(end.furtherWork, true);
      assert.equal(bodies.length, ONE_TURN);
      assert.deepEqual(recordedUnits(h), []);
      assert.ok(messages.includes("unit record skipped"));
    });

    test("a task that changes only checkout B records only checkout B and runs no turn in the next execution", async (t) => {
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
      const [, web] = h.checkouts;
      assert.deepEqual(h.input.setup.unit_records, [
        {
          unit_id: current.id,
          content_digest: digest(current.content),
          commits: [{ binding_id: web!.binding_id, commit: web!.head }],
        },
      ]);
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
      assert.deepEqual(recordedUnits(h), []);
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

    test("a failed unit record put logs unit record failed, ends nothing and the unit runs again in the next execution", async (t) => {
      const current = task("put-unit", "test -f put");
      const h = await fixture(
        t,
        [current],
        [write("put"), fauxAssistantMessage("done")],
      );
      recordFinish(h);
      refusePut(h, HttpStatus.ServiceUnavailable, UNAVAILABLE);
      const messages = logged(h);
      assert.deepEqual(
        await executionBoundary(h.run, () => runStepsImplement(h)),
        RELEASED,
      );
      assert.ok(messages.includes("unit record failed"));
      assert.deepEqual(recordedUnits(h), []);
      const next = await nextExecution(t, h, [fauxAssistantMessage("again")]);
      recordFinish(next);
      assert.deepEqual(
        await executionBoundary(next.run, () => runStepsImplement(next)),
        RELEASED,
      );
      assert.equal(next.provider.calls.length, ONE_TURN);
    });

    test("an execution-end answer of the unit record put ends the execution as revoked with no release", async (t) => {
      const current = task("revoked-unit", "test -f revoked");
      const h = await fixture(
        t,
        [current],
        [write("revoked"), fauxAssistantMessage("done")],
      );
      const bodies = recordFinish(h);
      refusePut(h, HttpStatus.Conflict, NOT_RUNNING);
      const messages = logged(h);
      const end = await executionBoundary(h.run, () => runStepsImplement(h));
      assert.ok("reason" in end);
      assert.equal(end.reason, REVOKED);
      assert.deepEqual(bodies, []);
      assert.equal(messages.includes("unit record failed"), false);
    });

    test("a unit record with a commit outside the node range reopens the unit", async (t) => {
      const current = task("range-unit", "test -f range");
      const h = await fixture(
        t,
        [current],
        [write("range"), fauxAssistantMessage("done")],
      );
      h.input.setup.unit_records = [
        {
          unit_id: current.id,
          content_digest: digest(current.content),
          commits: [
            { binding_id: h.checkouts[0]!.binding_id, commit: FOREIGN_COMMIT },
          ],
        },
      ];
      recordFinish(h);
      assert.deepEqual(
        await executionBoundary(h.run, () => runStepsImplement(h)),
        RELEASED,
      );
      assert.equal(h.provider.calls.length, ONE_TOOL_TURN);
    });

    test("a rebuilt node branch reopens a unit with a unit record of the old branch", async (t) => {
      const current = task("rebuilt-unit", "test -f rebuilt");
      const h = await fixture(
        t,
        [current],
        [write("rebuilt"), fauxAssistantMessage("done")],
      );
      recordFinish(h);
      assert.deepEqual(
        await executionBoundary(h.run, () => runStepsImplement(h)),
        RELEASED,
      );
      assert.deepEqual(recordedUnits(h), [current.id]);
      const next = await nextExecution(
        t,
        {
          ...h,
          input: {
            ...h.input,
            claim: {
              ...h.input.claim,
              node_branch: `${h.input.claim.node_branch}${REBUILT_SUFFIX}`,
            },
          },
        },
        [write("rebuilt"), fauxAssistantMessage("done again")],
      );
      recordFinish(next);
      assert.deepEqual(
        await executionBoundary(next.run, () => runStepsImplement(next)),
        RELEASED,
      );
      assert.equal(next.provider.calls.length, ONE_TOOL_TURN);
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
        source: VerdictSource.Rework,
        text: VERDICT,
        findings: [],
        round: null,
        judged: h.checkouts.map((checkout) => ({
          binding_id: checkout.binding_id,
          commit: checkout.head,
        })),
      };
    }

    test("a verdict unit that passes counts as completed when the budget ends in the release gate", async (t) => {
      const release = join(temporary(t), "release");
      const h = await fixture(
        t,
        [],
        [write("addressed"), fauxAssistantMessage("addressed")],
      );
      h.revision = nodeRevision(h, `touch ${release}`);
      await recordUnit(h, nodeUnitOf(h.input.claim.node_id, h.revision));
      h.verdict = verdictAtHead(h);
      h.agent.budget.exhausted = () => existsSync(release);
      const bodies = recordFinish(h);
      assert.deepEqual(
        await executionBoundary(h.run, () => runStepsImplement(h)),
        {
          kind: "released",
          furtherWork: true,
        },
      );
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

    test("unit records survive a base move and the template merge", async (t) => {
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
      const parents = await simpleGit(releasedRoot(next)).raw([
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ]);
      assert.equal(parents.trim().split(" ").length, MERGE_COMMIT_FIELDS);
    });
  },
);
