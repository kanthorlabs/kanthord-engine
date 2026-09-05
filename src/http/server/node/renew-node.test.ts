import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createTestApp,
  HARNESS_ACTOR_FIXTURE,
} from "../../../../test/helpers/app.ts";
import type { TestApp } from "../../../../test/helpers/app.ts";
import { renewNodeHandler } from "./renew-node.ts";
import {
  RenewRunError,
  type RenewRunInput,
} from "../../../commands/run/renew-run.ts";
import { nodeRenewResponse } from "../../contract/execution.ts";

const U = "01JQ8Z7G3HZZZZZZZZZZZZZZZZ";
const TASK = `task_${U}`;
const OBJECTIVE = `objective_${U}`;
const ACTOR = "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR";
const RUN_ID = `run_${U}`;

const successResult = {
  lease: {
    subjectId: TASK,
    owner: ACTOR,
    ownerKind: "actor",
    fence: 1,
    expiresAt: 1722800300000,
  },
  objectiveLease: {
    subjectId: OBJECTIVE,
    owner: ACTOR,
    ownerKind: "actor",
    fence: 1,
    expiresAt: 1722800300000,
  },
  expiresAt: 1722800300000,
  renewAfterMs: 100000,
};

describe("src/http/server/node/renew-node.test", () => {
  async function buildApp(
    renewRun: (input: RenewRunInput) => unknown,
  ): Promise<TestApp> {
    const app = await createTestApp({
      handlers: { "node.renew": renewNodeHandler({ renewRun }) },
      resolveActor: () => HARNESS_ACTOR_FIXTURE,
    });
    return app;
  }

  it("a successful call answers 200 with the contract response shape", async (t) => {
    const app = await buildApp(() => successResult);
    const response = await app
      .post(`/v1/node/${TASK}/renew`)
      .send({ fence: 1, runId: RUN_ID, runFence: 1 });
    assert.equal(response.status, 200);
    assert.equal(nodeRenewResponse.safeParse(response.body).success, true);
    assert.equal(response.body.renewAfterMs, 100000);
  });

  it("each refusal maps to its declared code", async (t) => {
    const cases = [
      {
        refusal: "node-not-found" as const,
        error: new RenewRunError("node-not-found", `no node ${TASK}`),
        code: "not-found",
        status: 404,
        details: undefined,
      },
      {
        refusal: "initiative-not-claimable" as const,
        error: new RenewRunError(
          "initiative-not-claimable",
          "an initiative is never claimed directly",
          { refusal: "initiative-not-claimable" },
        ),
        code: "invalid-request",
        status: 400,
        details: { refusal: "initiative-not-claimable" },
      },
      {
        refusal: "lease-held" as const,
        error: new RenewRunError(
          "lease-held",
          `the lease of ${TASK} is not held at fence 1`,
        ),
        code: "lease-held",
        status: 409,
        details: {
          refusal: "stale-fence",
          subject: TASK,
          presentedFence: 1,
        },
      },
    ];
    for (const row of cases) {
      const app = await buildApp(() => {
        throw row.error;
      });
      const response = await app
        .post(`/v1/node/${TASK}/renew`)
        .send({ fence: 1, runId: RUN_ID, runFence: 1 });
      assert.equal(response.status, row.status, row.refusal);
      assert.equal(response.body.error.code, row.code, row.refusal);
      if (row.details === undefined) {
        assert.equal(
          Object.hasOwn(response.body.error, "details"),
          false,
          row.refusal,
        );
      } else {
        assert.deepEqual(response.body.error.details, row.details, row.refusal);
      }
    }
  });

  it("a body with an unknown key is 400 invalid-request", async (t) => {
    const app = await buildApp(() => successResult);
    const response = await app
      .post(`/v1/node/${TASK}/renew`)
      .send({ fence: 1, runId: RUN_ID, runFence: 1, extra: 2 });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("node.renew with no fence is 400 invalid-request", async (t) => {
    const app = await buildApp(() => successResult);
    const response = await app
      .post(`/v1/node/${TASK}/renew`)
      .send({ runId: RUN_ID, runFence: 1 });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("the handler calls its command exactly once", async (t) => {
    let calls = 0;
    const app = await buildApp(() => {
      calls += 1;
      return successResult;
    });
    const response = await app
      .post(`/v1/node/${TASK}/renew`)
      .send({ fence: 1, runId: RUN_ID, runFence: 1 });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
  });

  it("the handler passes the authenticated actor and never a body actor", async (t) => {
    const received: unknown[] = [];
    const app = await buildApp((input: RenewRunInput) => {
      received.push(input);
      return successResult;
    });
    const ok = await app
      .post(`/v1/node/${TASK}/renew`)
      .send({ fence: 1, runId: RUN_ID, runFence: 1 });
    assert.equal(ok.status, 200);
    assert.deepEqual(received, [
      {
        nodeId: TASK,
        fence: 1,
        runId: RUN_ID,
        runFence: 1,
        actorId: HARNESS_ACTOR_FIXTURE.id,
        actorKind: "harness",
      },
    ]);

    const refused = await app.post(`/v1/node/${TASK}/renew`).send({
      fence: 1,
      runId: RUN_ID,
      runFence: 1,
      actorId: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQS",
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, "invalid-request");
  });

  it("a replayed node.renew under a repeated Idempotency-Key returns the captured expiresAt and writes nothing", async (t) => {
    let calls = 0;
    const app = await buildApp(() => {
      calls += 1;
      return successResult;
    });
    const first = await app
      .post(`/v1/node/${TASK}/renew`)
      .set("Idempotency-Key", "k-renew-1")
      .send({ fence: 1, runId: RUN_ID, runFence: 1 });
    assert.equal(first.status, 200);
    assert.equal(first.body.lease.expiresAt, 1722800300000);

    const second = await app
      .post(`/v1/node/${TASK}/renew`)
      .set("Idempotency-Key", "k-renew-1")
      .send({ fence: 1, runId: RUN_ID, runFence: 1 });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.equal(calls, 1);
  });
});
