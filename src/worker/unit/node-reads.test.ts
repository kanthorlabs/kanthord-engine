import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../../kernel/context.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { ClosingEvent } from "../../mission/contract.ts";
import { ExecutionRun, ExecutionStop } from "./execution-run.ts";
import {
  readAllPages,
  readClearedAssessment,
  readPriorRationale,
  readRequestedChanges,
  readReworkAssessment,
  READ_PAGE_LIMIT,
} from "./node-reads.ts";
import type { MethodClients } from "./method-clients.ts";

const SECOND_ATTEMPT = 2;
const ONE_READ = 1;
const CLEARED_RATIONALE = "cleared";
const REMOVED_BINDING = "binding_removed";
const REPOSITORIES = [
  { binding_id: "binding_api", name: "api" },
  { binding_id: "binding_web", name: "web" },
];

function fixture(attempt = 1) {
  return new ExecutionRun({
    claim: {
      execution_id: "execution",
      node_id: "node",
      attempt,
      pinned_revision: 1,
      node_branch: `kanthord/${"node"}`,
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      trace_id: "trace",
      root_span_id: "1".repeat(16),
    },
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
  });
}

test("reads concatenate ordered pages and enforce their finite limit", async (t) => {
  const run = fixture();
  t.after(() => run.dispose());
  const seen: (string | null)[] = [];
  const items = await readAllPages(run, async (cursor) => {
    seen.push(cursor);
    return {
      type: OperationResultType.Completed,
      status: 200,
      data: {
        items: cursor ? [2] : [1],
        next_cursor: cursor ? null : "second",
      },
    };
  });
  assert.deepEqual(items, [1, 2]);
  assert.deepEqual(seen, [null, "second"]);
  let calls = 0;
  await assert.rejects(
    readAllPages(run, async () => {
      calls++;
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: { items: [], next_cursor: "again" },
      };
    }),
    ExecutionStop,
  );
  assert.equal(calls, READ_PAGE_LIMIT);
});

test("the assessment reads answer null only on a record not found", async (t) => {
  const assessment = { id: "assessment", rationale: "unmet" };
  const failure = (status: number, code: string) => ({
    type: OperationResultType.Failure,
    status,
    error: {
      request_id: "request",
      error: { code, message: "failed", details: null },
    },
  });
  for (const [operation, read] of [
    ["execution.rework_assessment.get", readReworkAssessment],
    ["execution.cleared_assessment.get", readClearedAssessment],
  ] as const) {
    for (const [answer, expected] of [
      [
        { type: OperationResultType.Completed, status: 200, data: assessment },
        assessment,
      ],
      [failure(404, "mission.record.not_found"), null],
      [failure(404, "mission.execution.revision_above_pin"), ExecutionStop],
    ] as const) {
      const run = fixture(SECOND_ATTEMPT);
      t.after(() => run.dispose());
      run.clients.mission = {
        [operation]: async () => answer,
      } as unknown as MethodClients["mission"];
      if (expected === ExecutionStop)
        await assert.rejects(read(run), ExecutionStop);
      else assert.deepEqual(await read(run), expected);
    }
  }
});

test("the prior rationale is the rework rationale, else the cleared rationale, else null", async (t) => {
  const notFound = {
    type: OperationResultType.Failure,
    status: 404,
    error: {
      request_id: "request",
      error: {
        code: "mission.record.not_found",
        message: "failed",
        details: null,
      },
    },
  };
  const answered = (rationale: string) => ({
    type: OperationResultType.Completed,
    status: 200,
    data: { id: "assessment", rationale },
  });
  for (const [rework, cleared, expected] of [
    [answered("rework"), answered("cleared"), "rework"],
    [notFound, answered("cleared"), "cleared"],
    [answered("rework"), notFound, "rework"],
    [notFound, notFound, null],
  ] as const) {
    const run = fixture(SECOND_ATTEMPT);
    t.after(() => run.dispose());
    run.clients.mission = {
      "execution.rework_assessment.get": async () => rework,
      "execution.clearedOutcome.get": async () => notFound,
      "execution.cleared_assessment.get": async () => cleared,
    } as unknown as MethodClients["mission"];
    assert.deepEqual(await readPriorRationale(run, REPOSITORIES), {
      rationale: expected,
      rework: rework !== notFound,
    });
  }
});

function clearedOutcome(closingEvent: string) {
  return {
    type: OperationResultType.Completed,
    status: 200,
    data: { id: "outcome", closing_event: closingEvent },
  };
}

const NOT_FOUND = {
  type: OperationResultType.Failure,
  status: 404,
  error: {
    request_id: "request",
    error: {
      code: "mission.record.not_found",
      message: "failed",
      details: null,
    },
  },
};

const CHANGE_REQUESTS = {
  items: [
    {
      evidence_id: "evidence",
      binding_id: "binding_api",
      head_commit: "a".repeat(40),
      change_requests: [
        {
          review_id: 7,
          reviewer: "octo",
          body: "Rename the route.",
          submitted_at: "2026-10-12T00:00:00Z",
          commit_id: "a".repeat(40),
          comments: [
            { path: "src/route.ts", line: 4, body: "Use /api." },
            { path: "README.md", line: null, body: "Document it." },
          ],
        },
      ],
    },
  ],
};

test("the prior rationale of an attempt after a change request holds the requested changes", async (t) => {
  const run = fixture(SECOND_ATTEMPT);
  t.after(() => run.dispose());
  let reads = 0;
  run.clients.mission = {
    "execution.rework_assessment.get": async () => NOT_FOUND,
    "execution.clearedOutcome.get": async () =>
      clearedOutcome(ClosingEvent.ExternalFailed),
  } as unknown as MethodClients["mission"];
  run.clients.worker = {
    "execution.change_request.get": async () => {
      reads++;
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: CHANGE_REQUESTS,
      };
    },
  } as unknown as MethodClients["worker"];
  assert.equal(
    (await readPriorRationale(run, REPOSITORIES)).rationale,
    [
      "The pull request reviewers request these changes:",
      `Reviewer octo requests changes on api at commit ${"a".repeat(40)}: Rename the route.`,
      "- src/route.ts:4: Use /api.",
      "- README.md: Document it.",
    ].join("\n"),
  );
  assert.equal(reads, ONE_READ);
});

test("an attempt not ended by a change request reads no change request", async (t) => {
  for (const outcome of [
    clearedOutcome(ClosingEvent.AssessmentNotPassed),
    clearedOutcome(ClosingEvent.HumanBlock),
    NOT_FOUND,
  ]) {
    const run = fixture(SECOND_ATTEMPT);
    t.after(() => run.dispose());
    run.clients.mission = {
      "execution.rework_assessment.get": async () => NOT_FOUND,
      "execution.clearedOutcome.get": async () => outcome,
      "execution.cleared_assessment.get": async () => ({
        type: OperationResultType.Completed,
        status: 200,
        data: { id: "assessment", rationale: CLEARED_RATIONALE },
      }),
    } as unknown as MethodClients["mission"];
    run.clients.worker = {} as MethodClients["worker"];
    assert.equal(await readRequestedChanges(run, REPOSITORIES), null);
    assert.deepEqual(await readPriorRationale(run, REPOSITORIES), {
      rationale: CLEARED_RATIONALE,
      rework: false,
    });
  }
  const first = fixture();
  t.after(() => first.dispose());
  first.clients.mission = {} as MethodClients["mission"];
  first.clients.worker = {} as MethodClients["worker"];
  assert.equal(await readRequestedChanges(first, REPOSITORIES), null);
});

test("an external failure without a current change request keeps the cleared rationale", async (t) => {
  const run = fixture(SECOND_ATTEMPT);
  t.after(() => run.dispose());
  run.clients.mission = {
    "execution.rework_assessment.get": async () => NOT_FOUND,
    "execution.clearedOutcome.get": async () =>
      clearedOutcome(ClosingEvent.ExternalFailed),
    "execution.cleared_assessment.get": async () => ({
      type: OperationResultType.Completed,
      status: 200,
      data: { id: "assessment", rationale: CLEARED_RATIONALE },
    }),
  } as unknown as MethodClients["mission"];
  run.clients.worker = {
    "execution.change_request.get": async () => ({
      type: OperationResultType.Completed,
      status: 200,
      data: {
        items: [{ ...CHANGE_REQUESTS.items[0], change_requests: [] }],
      },
    }),
  } as unknown as MethodClients["worker"];
  assert.deepEqual(await readPriorRationale(run, REPOSITORIES), {
    rationale: CLEARED_RATIONALE,
    rework: false,
  });
});

test("the cleared assessment read of a first attempt answers null with no call", async (t) => {
  const run = fixture();
  t.after(() => run.dispose());
  run.clients.mission = {} as MethodClients["mission"];
  assert.equal(await readClearedAssessment(run), null);
});

test("each change request names its binding", async (t) => {
  const run = fixture(SECOND_ATTEMPT);
  t.after(() => run.dispose());
  const [item] = CHANGE_REQUESTS.items;
  assert.ok(item);
  run.clients.mission = {
    "execution.clearedOutcome.get": async () =>
      clearedOutcome(ClosingEvent.ExternalFailed),
  } as unknown as MethodClients["mission"];
  run.clients.worker = {
    "execution.change_request.get": async () => ({
      type: OperationResultType.Completed,
      status: 200,
      data: {
        items: [
          item,
          { ...item, evidence_id: "evidence_web", binding_id: "binding_web" },
        ].map((entry) => ({
          ...entry,
          change_requests: entry.change_requests.map((request) => ({
            ...request,
            comments: [],
          })),
        })),
      },
    }),
  } as unknown as MethodClients["worker"];
  const text = await readRequestedChanges(run, REPOSITORIES);
  assert.ok(text);
  assert.deepEqual(
    text.split("\n").slice(1),
    ["api", "web"].map(
      (name) =>
        `Reviewer octo requests changes on ${name} at commit ${"a".repeat(40)}: Rename the route.`,
    ),
  );
});

test("a change request of a binding that the pinned revision does not name names its binding_id", async (t) => {
  const run = fixture(SECOND_ATTEMPT);
  t.after(() => run.dispose());
  const [item] = CHANGE_REQUESTS.items;
  assert.ok(item);
  run.clients.mission = {
    "execution.clearedOutcome.get": async () =>
      clearedOutcome(ClosingEvent.ExternalFailed),
  } as unknown as MethodClients["mission"];
  run.clients.worker = {
    "execution.change_request.get": async () => ({
      type: OperationResultType.Completed,
      status: 200,
      data: { items: [{ ...item, binding_id: REMOVED_BINDING }] },
    }),
  } as unknown as MethodClients["worker"];
  const text = await readRequestedChanges(run, REPOSITORIES);
  assert.ok(text);
  assert.equal(
    text.split("\n")[1],
    `Reviewer octo requests changes on ${REMOVED_BINDING} at commit ${"a".repeat(40)}: Rename the route.`,
  );
});
