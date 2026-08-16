import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createTestApp,
  HARNESS_ACTOR_FIXTURE,
} from "../../../../test/helpers/app.ts";
import type { TestApp } from "../../../../test/helpers/app.ts";
import { claimNodeHandler } from "./claim-node.ts";
import {
  ClaimNodeError,
  type ClaimNodeInput,
} from "../../../commands/node/claim-node.ts";
import { nodeClaimResponse } from "../../contract/execution.ts";

const U = "01JQ8Z7G3HZZZZZZZZZZZZZZZZ";
const TASK = `task_${U}`;
const OBJECTIVE = `objective_${U}`;
const ACTOR = "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR";
const HASH = `sha256:${"a".repeat(64)}`;

const fullNode = {
  id: TASK,
  projectId: `project_${U}`,
  kind: "task",
  title: "add the health route",
  state: "running",
  blockReason: null,
  discardReason: null,
  parentId: OBJECTIVE,
  dependencies: [],
  instructionBlob: HASH,
  acceptanceBlob: null,
  instruction: "# atlas\n",
  acceptance: null,
  worker: null,
  repositoryId: `repo_${U}`,
  repo: "atlas",
  revision: `revision_${U}`,
  updatedAt: 1722800300000,
};

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
  runId: `run_${U}`,
  objectiveRunId: `run_${U}`,
  attemptId: `attempt_${U}`,
  attemptNo: 1,
  heartbeatIntervalMs: 100000,
  node: fullNode,
};

describe("src/http/server/node/claim-node.test", () => {
  async function buildApp(
    claimNode: (input: ClaimNodeInput) => unknown,
  ): Promise<TestApp> {
    const app = await createTestApp({
      handlers: { "node.claim": claimNodeHandler({ claimNode }) },
      resolveActor: () => HARNESS_ACTOR_FIXTURE,
    });
    return app;
  }

  it("a successful call answers 200 with the contract response shape", async (t) => {
    const app = await buildApp(() => successResult);
    const response = await app.post(`/v1/node/${TASK}/claim`).send({});
    assert.equal(response.status, 200);
    assert.equal(nodeClaimResponse.safeParse(response.body).success, true);
    assert.equal(response.body.heartbeatIntervalMs, 100000);
  });

  it("each refusal maps to its declared code", async (t) => {
    const cases = [
      {
        refusal: "node-not-found" as const,
        error: new ClaimNodeError("node-not-found", `no node ${TASK}`),
        code: "not-found",
        status: 404,
        details: undefined,
      },
      {
        refusal: "initiative-not-claimable" as const,
        error: new ClaimNodeError(
          "initiative-not-claimable",
          "an initiative is never claimed directly",
          { refusal: "initiative-not-claimable" },
        ),
        code: "invalid-request",
        status: 400,
        details: { refusal: "initiative-not-claimable" },
      },
      {
        refusal: "plan-incomplete" as const,
        error: new ClaimNodeError(
          "plan-incomplete",
          "the claim fails the completeness check",
          {
            findings: [
              {
                code: "objective-without-task",
                path: null,
                id: OBJECTIVE,
                message: "the objective holds no task",
              },
            ],
          },
        ),
        code: "plan-invalid",
        status: 422,
        details: {
          findings: [
            {
              code: "objective-without-task",
              path: null,
              id: OBJECTIVE,
              message: "the objective holds no task",
            },
          ],
        },
      },
      {
        refusal: "drive-mode-pinned" as const,
        error: new ClaimNodeError(
          "drive-mode-pinned",
          "the objective run is pinned to internal",
          { pinnedDriver: "internal", claimDriver: "external" },
        ),
        code: "illegal-transition",
        status: 409,
        details: {
          refusal: "drive-mode-pinned",
          pinnedDriver: "internal",
          claimDriver: "external",
        },
      },
      {
        refusal: "illegal-transition" as const,
        error: new ClaimNodeError(
          "illegal-transition",
          `the node ${TASK} is pending, not claimable`,
          { state: "pending", admitted: ["ready", "running"] },
        ),
        code: "illegal-transition",
        status: 409,
        details: {
          refusal: "node-state",
          state: "pending",
          admitted: ["ready", "running"],
        },
      },
      {
        refusal: "ancestor-not-startable" as const,
        error: new ClaimNodeError(
          "ancestor-not-startable",
          "the ancestor objective is done",
          {
            ancestorId: OBJECTIVE,
            state: "done",
            admitted: ["ready", "running"],
          },
        ),
        code: "illegal-transition",
        status: 409,
        details: {
          refusal: "ancestor-not-startable",
          ancestorId: OBJECTIVE,
          state: "done",
          admitted: ["ready", "running"],
        },
      },
      {
        refusal: "lease-held" as const,
        error: new ClaimNodeError(
          "lease-held",
          "the claim conflicts with a lease held by another owner",
          {
            subject: OBJECTIVE,
            holder: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQS",
            holderKind: "actor",
            fence: 1,
            expiresAt: 1722800300000,
            relation: "ancestor",
          },
        ),
        code: "lease-held",
        status: 409,
        details: {
          refusal: "held-by-other",
          subject: OBJECTIVE,
          holder: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQS",
          holderKind: "actor",
          fence: 1,
          expiresAt: 1722800300000,
          relation: "ancestor",
        },
      },
    ];
    for (const row of cases) {
      const app = await buildApp(() => {
        throw row.error;
      });
      const response = await app.post(`/v1/node/${TASK}/claim`).send({});
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
      .post(`/v1/node/${TASK}/claim`)
      .send({ fence: 1 });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("node.claim with any body member is 400 invalid-request", async (t) => {
    const app = await buildApp(() => successResult);
    for (const body of [{ actorId: ACTOR }, { fence: 1 }]) {
      const response = await app.post(`/v1/node/${TASK}/claim`).send(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, "invalid-request");
    }
  });

  it("the handler calls its command exactly once", async (t) => {
    let calls = 0;
    const app = await buildApp(() => {
      calls += 1;
      return successResult;
    });
    const response = await app.post(`/v1/node/${TASK}/claim`).send({});
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
  });

  it("the handler passes the authenticated actor and never a body actor", async (t) => {
    const received: unknown[] = [];
    const app = await buildApp((input: ClaimNodeInput) => {
      received.push(input);
      return successResult;
    });
    const ok = await app.post(`/v1/node/${TASK}/claim`).send({});
    assert.equal(ok.status, 200);
    assert.deepEqual(received, [
      { nodeId: TASK, actorId: HARNESS_ACTOR_FIXTURE.id, actorKind: "harness" },
    ]);

    const refused = await app
      .post(`/v1/node/${TASK}/claim`)
      .send({ actorId: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQS" });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, "invalid-request");
  });
});
