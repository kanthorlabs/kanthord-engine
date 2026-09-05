import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createTestApp,
  HARNESS_ACTOR_FIXTURE,
} from "../../../../test/helpers/app.ts";
import type { TestApp } from "../../../../test/helpers/app.ts";
import { reportNodeHandler } from "./report-node.ts";
import {
  ReportOutcomeError,
  type ReportOutcomeInput,
  type ReportOutcomeResult,
} from "../../../commands/outcome/report-outcome.ts";
import { ReportObjectiveError } from "../../../commands/outcome/report-objective.ts";
import { CloseObjectiveError } from "../../../commands/outcome/close-objective.ts";
import { buildErrorEnvelope } from "../../contract/errors.ts";
import { registry } from "../../contract/registry.ts";

const U = "01JQ8Z7G3HZZZZZZZZZZZZZZZZ";
const TASK = `task_${U}`;
const RUN_ID = `run_${U}`;
const OID40 = "a".repeat(40);

function reportErrorEnvelope(): ReturnType<typeof buildErrorEnvelope> {
  const operation = registry.find(
    (candidate) => candidate.operationId === "node.report",
  );
  assert.ok(operation !== undefined, "node.report is absent from the registry");
  assert.ok(operation.errors !== undefined, "node.report declares no errors");
  return buildErrorEnvelope(operation.errors);
}
const OID64 = "b".repeat(64);

const successResult: ReportOutcomeResult = {
  nodeId: TASK,
  kind: "task",
  state: "done",
  blockReason: null,
  attemptId: `attempt_${U}`,
  attemptNo: 1,
  attemptsRemaining: 2,
  objectId: OID40,
  objectiveState: "running",
  objectiveProjection: null,
};

describe("src/http/server/node/report-node.test", () => {
  async function buildApp(
    reportOutcome: (input: ReportOutcomeInput) => ReportOutcomeResult,
  ): Promise<TestApp> {
    return createTestApp({
      handlers: { "node.report": reportNodeHandler({ reportOutcome }) },
      resolveActor: () => HARNESS_ACTOR_FIXTURE,
    });
  }

  it("a valid accepted body reaches the command once", async (t) => {
    const received: unknown[] = [];
    const app = await buildApp((input) => {
      received.push(input);
      return successResult;
    });
    const response = await app.post(`/v1/node/${TASK}/report`).send({
      report: "accepted",
      fence: 1,
      runId: RUN_ID,
      runFence: 1,
      objectId: OID40,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, [
      {
        nodeId: TASK,
        actorId: HARNESS_ACTOR_FIXTURE.id,
        actorKind: "harness",
        runId: RUN_ID,
        runFence: 1,
        body: { report: "accepted", fence: 1, objectId: OID40 },
      },
    ]);
  });

  it("a body carrying timed-out is invalid-request", async (t) => {
    let calls = 0;
    const app = await buildApp(() => {
      calls += 1;
      return successResult;
    });
    const response = await app
      .post(`/v1/node/${TASK}/report`)
      .send({ report: "timed-out", fence: 1 });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(calls, 0);
  });

  it("an accepted body with no objectId, a rejected body with no reason, and an accepted body carrying a reason are each invalid-request", async (t) => {
    const bodies = [
      { report: "accepted", fence: 1 },
      { report: "rejected", fence: 1 },
      { report: "accepted", fence: 1, objectId: OID40, reason: "why not" },
    ];
    for (const body of bodies) {
      let calls = 0;
      const app = await buildApp(() => {
        calls += 1;
        return successResult;
      });
      const response = await app
        .post(`/v1/node/${TASK}/report`)
        .send({ ...body, runId: RUN_ID, runFence: 1 });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, "invalid-request");
      assert.equal(calls, 0);
    }
  });

  it("a body carrying an owner key is invalid-request", async (t) => {
    const bodies = [
      { report: "accepted", fence: 1, objectId: OID40, owner: "actor_x" },
      { report: "rejected", fence: 1, reason: "no", owner: "actor_x" },
      { report: "failed", fence: 1, reason: "no", owner: "actor_x" },
      { report: "cancelled", fence: 1, owner: "actor_x" },
      { report: "attested", fence: 1, objectId: OID40, owner: "actor_x" },
      { report: "closed", acknowledgePartial: true, owner: "actor_x" },
    ];
    for (const body of bodies) {
      let calls = 0;
      const app = await buildApp(() => {
        calls += 1;
        return successResult;
      });
      const response = await app.post(`/v1/node/${TASK}/report`).send(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, "invalid-request");
      assert.equal(calls, 0);
    }
  });

  it("a 40-character and a 64-character object id are each accepted", async (t) => {
    for (const objectId of [OID40, OID64]) {
      let calls = 0;
      const app = await buildApp(() => {
        calls += 1;
        return successResult;
      });
      const response = await app.post(`/v1/node/${TASK}/report`).send({
        report: "accepted",
        fence: 1,
        runId: RUN_ID,
        runFence: 1,
        objectId,
      });
      assert.equal(response.status, 200, objectId);
      assert.equal(calls, 1);
    }
  });

  it("a 39, a 41, a 63-character and an uppercase object id are each invalid-request", async (t) => {
    const objectIds = [
      "a".repeat(39),
      "b".repeat(41),
      "c".repeat(63),
      "A".repeat(40),
    ];
    for (const objectId of objectIds) {
      let calls = 0;
      const app = await buildApp(() => {
        calls += 1;
        return successResult;
      });
      const response = await app.post(`/v1/node/${TASK}/report`).send({
        report: "accepted",
        fence: 1,
        runId: RUN_ID,
        runFence: 1,
        objectId,
      });
      assert.equal(response.status, 400, objectId);
      assert.equal(response.body.error.code, "invalid-request");
      assert.equal(calls, 0);
    }
  });

  it("each refusal maps to its code", async (t) => {
    const cases = [
      {
        error: new ReportOutcomeError("node-not-found", `no node ${TASK}`),
        code: "not-found",
        status: 404,
        details: undefined,
      },
      {
        error: new ReportOutcomeError(
          "initiative-not-reportable",
          `the initiative ${TASK} is never reported`,
          { refusal: "initiative-not-reportable" },
        ),
        code: "invalid-request",
        status: 400,
        details: { refusal: "initiative-not-reportable" },
      },
      {
        error: new ReportOutcomeError(
          "body-kind-mismatch",
          `a task report names a task node, not the objective ${TASK}`,
          { refusal: "body-kind-mismatch" },
        ),
        code: "invalid-request",
        status: 400,
        details: { refusal: "body-kind-mismatch" },
      },
      {
        error: new ReportOutcomeError(
          "actor-forbidden",
          `a human actor never reports a task outcome`,
        ),
        code: "actor-forbidden",
        status: 403,
        details: undefined,
      },
      {
        error: new ReportOutcomeError(
          "illegal-transition",
          `the task ${TASK} is blocked, not running`,
          { state: "blocked", admitted: ["running"] },
        ),
        code: "illegal-transition",
        status: 409,
        details: {
          refusal: "node-state",
          state: "blocked",
          admitted: ["running"],
        },
      },
      {
        error: new ReportOutcomeError(
          "lease-held",
          `the lease of ${TASK} is not held by actor_x at fence 1`,
          {
            subject: TASK,
            holder: "actor_x",
            holderKind: "actor",
            fence: 1,
            expiresAt: 1700000000000,
            relation: "self",
          },
        ),
        code: "lease-held",
        status: 409,
        details: {
          refusal: "held-by-other",
          subject: TASK,
          holder: "actor_x",
          holderKind: "actor",
          fence: 1,
          expiresAt: 1700000000000,
          relation: "self",
        },
      },
      {
        error: new ReportObjectiveError(
          "actor-forbidden",
          `a human actor never attests an objective`,
        ),
        code: "actor-forbidden",
        status: 403,
        details: undefined,
      },
      {
        error: new ReportObjectiveError(
          "illegal-transition",
          `the objective ${TASK} is pending, not running`,
          { state: "pending", admitted: ["running"] },
        ),
        code: "illegal-transition",
        status: 409,
        details: {
          refusal: "node-state",
          state: "pending",
          admitted: ["running"],
        },
      },
      {
        error: new ReportObjectiveError(
          "lease-held",
          `the lease of ${TASK} is not held by actor_x at fence 2`,
        ),
        code: "lease-held",
        status: 409,
        details: { refusal: "stale-fence", subject: TASK, presentedFence: 1 },
      },
      {
        error: new CloseObjectiveError(
          "illegal-transition",
          `the objective ${TASK} is done, not awaiting approval`,
          { state: "done", admitted: ["awaiting_approval"] },
        ),
        code: "illegal-transition",
        status: 409,
        details: {
          refusal: "node-state",
          state: "done",
          admitted: ["awaiting_approval"],
        },
      },
      {
        error: new CloseObjectiveError(
          "acknowledgement-required",
          `a partial objective needs the acknowledgement`,
        ),
        code: "acknowledgement-required",
        status: 409,
        details: undefined,
      },
    ];
    for (const row of cases) {
      const app = await buildApp(() => {
        throw row.error;
      });
      const response = await app.post(`/v1/node/${TASK}/report`).send({
        report: "accepted",
        fence: 1,
        runId: RUN_ID,
        runFence: 1,
        objectId: OID40,
      });
      assert.equal(response.status, row.status, row.error.refusal);
      assert.equal(response.body.error.code, row.code, row.error.refusal);
      if (row.details === undefined) {
        assert.equal(
          Object.hasOwn(response.body.error, "details"),
          false,
          row.error.refusal,
        );
      } else {
        assert.deepEqual(
          response.body.error.details,
          row.details,
          row.error.refusal,
        );
      }
      assert.doesNotThrow(
        () => reportErrorEnvelope().parse(response.body),
        row.error.refusal,
      );
    }
  });

  it("the handler branches on no domain rule", async (t) => {
    const bodies = [
      { report: "accepted", fence: 1, objectId: OID40 },
      { report: "rejected", fence: 1, reason: "not good" },
      { report: "failed", fence: 1, reason: "boom" },
      { report: "cancelled", fence: 1 },
      { report: "attested", fence: 1, objectId: OID40 },
      { report: "closed", acknowledgePartial: true },
    ];
    for (const body of bodies) {
      let calls = 0;
      const app = await buildApp(() => {
        calls += 1;
        return successResult;
      });
      const response = await app
        .post(`/v1/node/${TASK}/report`)
        .send({ ...body, runId: RUN_ID, runFence: 1 });
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(calls, 1, JSON.stringify(body));
    }
  });
});
