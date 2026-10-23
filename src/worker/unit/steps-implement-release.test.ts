import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { fauxAssistantMessage, fauxToolCall } from "./test-support.ts";
import { EndReason } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import type { MethodClients } from "./method-clients.ts";
import type { TaskRunner } from "./steps-implement.ts";
import { runTask, runStepsImplement } from "./steps-implement.ts";
import { nodeUnitOf, releaseGate, ReleaseGateKind } from "./release-gate.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { background } from "../../kernel/context.ts";
import { commitWork } from "./local-git.ts";
import {
  RecordKind,
  SpanStatus,
  type TelemetryRecord,
} from "../../tracking/contract.ts";
import { SpanOperation, SpanRecorder } from "./telemetry.ts";
import { GitStep } from "./method-telemetry.ts";
import {
  advanceBase,
  implementFixture as fixture,
  NO_PROVIDER_CALLS,
  recordDone,
  recordReleases,
  STEPS_KEY,
  task,
  transport,
} from "./test-support.ts";

const NO_PUSHES = 0;
const LATE_MAIN_CHANGE = "late main change";

async function recordNodeDone(h: Awaited<ReturnType<typeof fixture>>) {
  await recordDone(h, nodeUnitOf(h.input.claim.node_id, h.revision));
}

test("implement pushes the evidenced head before release and retains its workspace", async (t) => {
  const h = await fixture(t, [], []);
  await recordNodeDone(h);
  const order: string[] = [];
  h.run.clients.mission = {
    "evidence.submit": async (input: {
      body: { assets: { address: { commit: string } }[] };
    }) => {
      order.push("evidence");
      const remote = (
        await simpleGit(h.bare).revparse([`refs/heads/${h.nodeBranch}`])
      ).trim();
      assert.equal(input.body.assets[0]!.address.commit, remote);
      return { type: "completed", status: 200, data: { evidence: {} } };
    },
  } as unknown as MethodClients["mission"];
  h.run.clients.scheduler = {
    executionRelease: async () => {
      order.push("release");
      return { type: "completed", status: 200, data: {} };
    },
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(await runStepsImplement(h), {
    kind: "released",
    furtherWork: false,
  });
  assert.deepEqual(order, ["evidence", "release"]);
  assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
  assert.ok(existsSync(h.root));
});

test("implement checkpoints budget-ended work and refuses release after a failed push", async (t) => {
  const current = task("partial", "false");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: "notes", content: "partial" }),
        { stopReason: "toolUse" },
      ),
    ],
    1,
  );
  let released = false;
  h.run.clients.scheduler = {
    executionRelease: async (input: { body: { further_work: boolean } }) => {
      released = input.body.further_work;
      return { type: "completed", status: 200, data: {} };
    },
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(await runStepsImplement(h), {
    kind: "released",
    furtherWork: true,
    stop: { reason: "budget_end", code: "turns" },
  });
  assert.ok(released);
  const log = await simpleGit(h.bare).raw([
    "log",
    "-1",
    "--format=%s",
    `refs/heads/${h.nodeBranch}`,
  ]);
  assert.match(log, /checkpoint of task/);
  const other = await fixture(t, [], []);
  other.input.transport = {
    ...transport,
    pushNodeBranch: async () => {
      throw new Error("push failed");
    },
  };
  await assert.rejects(runStepsImplement(other));
  assert.ok(existsSync(other.root));
});

test("S1 budget-ended task verification releases further work and submits no evidence", async (t) => {
  const current = task("failed-budget", "false");
  const h = await fixture(t, [current], []);
  h.agent.budget.exhausted = () => true;
  let evidenced = false;
  let released = false;
  h.run.clients.mission = {
    "evidence.submit": async () => {
      evidenced = true;
      return { type: "completed", status: 200, data: { evidence: {} } };
    },
  } as unknown as MethodClients["mission"];
  h.run.clients.scheduler = {
    executionRelease: async (input: { body: { further_work: boolean } }) => {
      assert.equal(input.body.further_work, true);
      released = true;
      return { type: "completed", status: 200, data: {} };
    },
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(await runStepsImplement(h), {
    kind: "released",
    furtherWork: true,
    stop: { reason: "budget_end", code: "wall_time" },
  });
  assert.ok(released);
  assert.equal(evidenced, false);
  const timed = await fixture(
    t,
    [task("timed", "touch transient; sleep 30")],
    [fauxAssistantMessage("work")],
  );
  let deadline = Date.now() + 60000;
  timed.agent.budget.wallDeadline = () => {
    deadline = Date.now() + 30;
    return deadline;
  };
  timed.agent.budget.exhausted = () => Date.now() >= deadline;
  assert.deepEqual(await runTask(timed, timed.revision.tasks![0]!), {
    kind: "budget_end",
  });
  assert.equal(existsSync(join(timed.root, "transient")), false);
});

const STOP_REASONS = [
  EndReason.OperationFailed,
  EndReason.JudgementInvalid,
  EndReason.ReportAbsent,
  EndReason.ActionUnsettled,
  EndReason.AssessmentAbsent,
];
const STOP_CODE = "test.operation.failed";
const PARTIAL_WORK = "partial";

function stoppingRunner(reason: EndReason): TaskRunner {
  return async (state) => {
    writeFileSync(join(state.root, PARTIAL_WORK), PARTIAL_WORK);
    return state.run.stop(reason, STOP_CODE);
  };
}

for (const reason of STOP_REASONS) {
  test(`a stop with the reason ${reason} checkpoints, pushes and releases with the stop`, async (t) => {
    const h = await fixture(t, [task("stopped", "false")], []);
    const bodies = recordReleases(h);
    const stop = { reason, code: STOP_CODE };
    assert.deepEqual(
      await executionBoundary(h.run, () =>
        runStepsImplement(h, stoppingRunner(reason)),
      ),
      { kind: "released", furtherWork: true, stop },
    );
    assert.deepEqual(bodies, [{ further_work: true, stop }]);
    const branch = `refs/heads/${h.nodeBranch}`;
    assert.match(
      await simpleGit(h.bare).raw(["log", "-1", "--format=%s", branch]),
      /checkpoint of task/,
    );
    assert.equal(
      await simpleGit(h.bare).raw(["show", `${branch}:${PARTIAL_WORK}`]),
      PARTIAL_WORK,
    );
  });
}

test("a failed push still releases with the stop and a failed release ends with no release", async (t) => {
  const pushed = await fixture(t, [task("stopped", "false")], []);
  pushed.input.transport = {
    ...transport,
    pushNodeBranch: async () => {
      throw new Error("push failed");
    },
  };
  const bodies = recordReleases(pushed);
  const stop = { reason: EndReason.OperationFailed, code: STOP_CODE };
  assert.deepEqual(
    await executionBoundary(pushed.run, () =>
      runStepsImplement(pushed, stoppingRunner(EndReason.OperationFailed)),
    ),
    { kind: "released", furtherWork: true, stop },
  );
  assert.deepEqual(bodies, [{ further_work: true, stop }]);
  const refused = await fixture(t, [task("stopped", "false")], []);
  refused.run.clients.scheduler = {
    executionRelease: async () => {
      throw new Error("release failed");
    },
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(
    await executionBoundary(refused.run, () =>
      runStepsImplement(refused, stoppingRunner(EndReason.OperationFailed)),
    ),
    { kind: "ended", ...stop },
  );
});

const COMMIT_REFUSAL = "hook refused";
const COMMIT_DEADLINE_MS = 10000;
const CHECKPOINT_FAILED = "checkpoint failed";
const REDACTED_REFUSAL = new RegExp(`${COMMIT_REFUSAL} \\[redacted\\]`);
const SECRET_TEXT = new RegExp(STEPS_KEY);

function refuseCommits(directory: string): void {
  appendFileSync(
    join(directory, ".git", "config"),
    `[commit]\n\tgpgSign = true\n[gpg]\n\tformat = ssh\n[user]\n\tsigningKey = ${COMMIT_REFUSAL} ${STEPS_KEY}\n`,
  );
}

const committingRunner: TaskRunner = async (state) => {
  const directory = state.checkouts[0]!.directory;
  writeFileSync(join(directory, PARTIAL_WORK), PARTIAL_WORK);
  await commitWork(
    state.input.env,
    directory,
    PARTIAL_WORK,
    background,
    COMMIT_DEADLINE_MS,
  );
  assert.fail("The commit must fail.");
};

test("a failed commit releases the stop with its redacted cause and logs the dropped checkpoint error", async (t) => {
  const h = await fixture(t, [task("refused", "false")], []);
  refuseCommits(h.checkouts[0]!.directory);
  const bodies = recordReleases(h);
  const events = t.mock.method(h.run, "log");
  const end = await executionBoundary(h.run, () =>
    runStepsImplement(h, committingRunner),
  );
  const [body, ...others] = bodies as { stop: { detail?: string } }[];
  assert.deepEqual(others, []);
  const stop = body!.stop;
  const { detail, ...cause } = stop;
  assert.deepEqual(cause, { reason: EndReason.OperationFailed, code: null });
  assert.match(String(detail), REDACTED_REFUSAL);
  assert.doesNotMatch(String(detail), SECRET_TEXT);
  assert.deepEqual(end, { kind: "released", furtherWork: true, stop });
  const dropped = events.mock.calls
    .filter((call) => call.arguments[0] === CHECKPOINT_FAILED)
    .map((call) => String(call.arguments[1].reason));
  assert.deepEqual(
    dropped.map((reason) => REDACTED_REFUSAL.test(reason)),
    [true],
  );
  assert.doesNotMatch(dropped.join(), SECRET_TEXT);
});

test("a revoked stop writes no checkpoint, pushes nothing and releases nothing", async (t) => {
  const h = await fixture(t, [task("stopped", "false")], []);
  const bodies = recordReleases(h);
  let pushes = 0;
  h.input.transport = {
    ...transport,
    pushNodeBranch: async () => {
      pushes++;
    },
  };
  assert.deepEqual(
    await executionBoundary(h.run, () =>
      runStepsImplement(h, stoppingRunner(EndReason.Revoked)),
    ),
    { kind: "ended", reason: EndReason.Revoked, code: STOP_CODE },
  );
  assert.deepEqual(bodies, []);
  assert.equal(pushes, NO_PUSHES);
  assert.equal(
    (await simpleGit(h.root).status()).not_added.includes(PARTIAL_WORK),
    true,
  );
});

test("the release gate merges a clean base change and verifies the merged head", async (t) => {
  const passing = await fixture(t, [task("pass", "true")], []);
  const records: TelemetryRecord[] = [];
  (passing.run as { spans: SpanRecorder }).spans = new SpanRecorder(
    passing.run.claim,
    "coder-1",
    { write: (batch) => records.push(...batch), flush: async () => {} },
  );
  const before = passing.checkouts[0]!.head;
  await advanceBase(passing, t, LATE_MAIN_CHANGE, "other");
  assert.deepEqual(await releaseGate(passing), {
    kind: ReleaseGateKind.Passed,
  });
  assert.deepEqual(
    records.flatMap((record) =>
      record.kind === RecordKind.Span &&
      record.operation === SpanOperation.Git &&
      "start_time" in record
        ? [record.attributes?.["kanthord.git.step"]]
        : [],
    ),
    [GitStep.FetchBase, GitStep.MergeBase],
  );
  assert.equal(
    readFileSync(join(passing.root, "other"), "utf8"),
    LATE_MAIN_CHANGE,
  );
  assert.notEqual(passing.checkouts[0]!.head, before);
  assert.equal(
    (await simpleGit(passing.root).revparse(["HEAD"])).trim(),
    passing.checkouts[0]!.head,
  );
});

test("the finish writes one git span for each git step and the cause of a failed push", async (t) => {
  const h = await fixture(t, [], []);
  await recordNodeDone(h);
  const records: TelemetryRecord[] = [];
  (h.run as { spans: SpanRecorder }).spans = new SpanRecorder(
    h.run.claim,
    "coder-1",
    { write: (batch) => records.push(...batch), flush: async () => {} },
  );
  const cause =
    "push node branch: fatal: Could not read from remote repository.";
  h.input.transport = {
    ...transport,
    pushNodeBranch: async () => {
      throw new Diagnostic(
        "repository.connector.git_failed",
        "push node branch: git failed.",
        { cause: new Error(cause) },
      );
    },
  };
  await assert.rejects(runStepsImplement(h));
  const gitStarts = records.filter(
    (record) =>
      record.kind === RecordKind.Span &&
      record.operation === SpanOperation.Git &&
      "start_time" in record,
  );
  const steps = gitStarts.map((record) =>
    record.kind === RecordKind.Span
      ? record.attributes?.["kanthord.git.step"]
      : undefined,
  );
  assert.deepEqual(steps, [GitStep.FetchBase, GitStep.Push]);
  const push = gitStarts.at(-1)!;
  assert.ok(push.kind === RecordKind.Span);
  const end = records.find(
    (record) =>
      record.kind === RecordKind.Span &&
      record.span_id === push.span_id &&
      "end_time" in record,
  );
  assert.ok(end && end.kind === RecordKind.Span);
  assert.equal(end.status, SpanStatus.Error);
  const texts = records.filter(
    (record) =>
      record.kind === RecordKind.Text && end.text_ids?.includes(record.text_id),
  );
  assert.deepEqual(
    texts.map((record) => (record.kind === RecordKind.Text ? record.text : "")),
    [`repository.connector.git_failed: ${cause}`],
  );
});

const TWO_BINDINGS = ["api", "web"];

async function twoBindingRelease(t: test.TestContext) {
  const h = await fixture(t, [], [], undefined, TWO_BINDINGS);
  for (const checkout of h.checkouts) {
    writeFileSync(join(checkout.directory, "node-work"), checkout.name);
    await simpleGit(checkout.directory).add("node-work");
    await simpleGit(checkout.directory).commit("node work");
    checkout.head = (
      await simpleGit(checkout.directory).revparse(["HEAD"])
    ).trim();
  }
  await recordNodeDone(h);
  const submitted: { binding_id: string; commit: string }[][] = [];
  const order: string[] = [];
  h.run.clients.mission = {
    "evidence.submit": async (input: {
      body: { assets: { address: { binding_id: string; commit: string } }[] };
    }) => {
      order.push("evidence");
      submitted.push(input.body.assets.map((asset) => asset.address));
      return { type: "completed", status: 200, data: { evidence: {} } };
    },
  } as unknown as MethodClients["mission"];
  h.run.clients.scheduler = {
    executionRelease: async () => {
      order.push("release");
      return { type: "completed", status: 200, data: {} };
    },
  } as unknown as MethodClients["scheduler"];
  return { h, submitted, order };
}

test("two bindings push both node branches before the evidence", async (t) => {
  const { h, order } = await twoBindingRelease(t);
  const pushTransport = h.input.transport;
  h.input.transport = {
    ...pushTransport,
    pushNodeBranch: async (...args) => {
      order.push(`push:${args[0]}`);
      return pushTransport.pushNodeBranch(...args);
    },
  };
  assert.deepEqual(await runStepsImplement(h), {
    kind: "released",
    furtherWork: false,
  });
  assert.deepEqual(order, [
    ...h.checkouts.map((checkout) => `push:${checkout.directory}`),
    "evidence",
    "release",
  ]);
  for (const [index, checkout] of h.checkouts.entries())
    assert.equal(
      (
        await simpleGit(h.bares[index]!).revparse([
          `refs/heads/${h.nodeBranch}`,
        ])
      ).trim(),
      checkout.head,
    );
});

test("one failed push submits no evidence", async (t) => {
  const { h, submitted } = await twoBindingRelease(t);
  const web = h.checkouts[1]!.directory;
  h.input.transport = {
    ...h.input.transport,
    pushNodeBranch: async (...args) => {
      if (args[0] === web) throw new Error("push failed");
      return transport.pushNodeBranch(...args);
    },
  };
  await assert.rejects(runStepsImplement(h));
  assert.deepEqual(submitted, []);
});

test("the evidence holds one asset for each binding", async (t) => {
  const { h, submitted } = await twoBindingRelease(t);
  await runStepsImplement(h);
  assert.deepEqual(submitted, [
    h.checkouts.map((checkout) => ({
      kind: "repository",
      binding_id: checkout.binding_id,
      commit: checkout.head,
    })),
  ]);
  assert.deepEqual(
    submitted[0]!.map((address) => address.binding_id),
    h.input.setup.repositories.map((repository) => repository.binding_id),
  );
});
