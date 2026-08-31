import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createTestApp,
  HARNESS_ACTOR_FIXTURE,
} from "../../../../test/helpers/app.ts";
import type { TestApp } from "../../../../test/helpers/app.ts";
import { releaseNodeHandler } from "./release-node.ts";
import {
  ReleaseNodeError,
  type ReleaseNodeInput,
} from "../../../commands/node/release-node.ts";
import { nodeReleaseResponse } from "../../contract/execution.ts";

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
  state: "ready",
  blockReason: null,
  discardReason: null,
  parentId: OBJECTIVE,
  dependencies: [],
  instructionBlob: HASH,
  acceptanceBlob: null,
  instruction: "# atlas\n",
  acceptance: null,
  worker: null,
  deliverable: null,
  verify: null,
  repositoryId: `repo_${U}`,
  repo: "atlas",
  revision: `revision_${U}`,
  updatedAt: 1722800300000,
  attestedObjectId: null,
  projection: null,
};

const successResult = { node: fullNode };

describe("src/http/server/node/release-node.test", () => {
  async function buildApp(
    releaseNode: (input: ReleaseNodeInput) => unknown,
  ): Promise<TestApp> {
    const app = await createTestApp({
      handlers: { "node.release": releaseNodeHandler({ releaseNode }) },
      resolveActor: () => HARNESS_ACTOR_FIXTURE,
    });
    return app;
  }

  it("a successful call answers 200 with the contract response shape", async (t) => {
    const app = await buildApp(() => successResult);
    const response = await app
      .post(`/v1/node/${TASK}/release`)
      .send({ fence: 1 });
    assert.equal(response.status, 200);
    assert.equal(nodeReleaseResponse.safeParse(response.body).success, true);
  });

  it("each refusal maps to its declared code", async (t) => {
    const cases = [
      {
        refusal: "node-not-found" as const,
        error: new ReleaseNodeError("node-not-found", `no node ${TASK}`),
        code: "not-found",
        status: 404,
        details: undefined,
      },
      {
        refusal: "initiative-not-claimable" as const,
        error: new ReleaseNodeError(
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
        error: new ReleaseNodeError(
          "lease-held",
          `the task ${TASK} under ${OBJECTIVE} is still held`,
          {
            subject: TASK,
            holder: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQS",
            holderKind: "actor",
            fence: 1,
            expiresAt: 1722800300000,
            relation: "descendant",
          },
        ),
        code: "lease-held",
        status: 409,
        details: {
          refusal: "held-by-other",
          subject: TASK,
          holder: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQS",
          holderKind: "actor",
          fence: 1,
          expiresAt: 1722800300000,
          relation: "descendant",
        },
      },
      {
        refusal: "no-active-run" as const,
        error: new ReleaseNodeError(
          "no-active-run",
          `no active run of node ${TASK}`,
        ),
        code: "illegal-transition",
        status: 409,
        details: {
          refusal: "node-state",
          state: "ready",
          admitted: ["ready", "running"],
        },
      },
      {
        refusal: "no-open-attempt" as const,
        error: new ReleaseNodeError(
          "no-open-attempt",
          `no open attempt of run run_${U}`,
        ),
        code: "illegal-transition",
        status: 409,
        details: {
          refusal: "node-state",
          state: "running",
          admitted: ["ready", "running"],
        },
      },
      {
        refusal: "illegal-transition" as const,
        error: new ReleaseNodeError(
          "illegal-transition",
          `the node ${TASK} is blocked, not releasable`,
          { state: "blocked", admitted: ["ready", "running"] },
        ),
        code: "illegal-transition",
        status: 409,
        details: {
          refusal: "node-state",
          state: "blocked",
          admitted: ["ready", "running"],
        },
      },
    ];
    for (const row of cases) {
      const app = await buildApp(() => {
        throw row.error;
      });
      const response = await app
        .post(`/v1/node/${TASK}/release`)
        .send({ fence: 1 });
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
      .post(`/v1/node/${TASK}/release`)
      .send({ fence: 1, extra: 2 });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("node.release with no fence is 400 invalid-request", async (t) => {
    const app = await buildApp(() => successResult);
    const response = await app.post(`/v1/node/${TASK}/release`).send({});
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
      .post(`/v1/node/${TASK}/release`)
      .send({ fence: 1 });
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
  });

  it("the handler passes the authenticated actor and never a body actor", async (t) => {
    const received: unknown[] = [];
    const app = await buildApp((input: ReleaseNodeInput) => {
      received.push(input);
      return successResult;
    });
    const ok = await app.post(`/v1/node/${TASK}/release`).send({ fence: 1 });
    assert.equal(ok.status, 200);
    assert.deepEqual(received, [
      {
        nodeId: TASK,
        fence: 1,
        actorId: HARNESS_ACTOR_FIXTURE.id,
        actorKind: "harness",
      },
    ]);

    const refused = await app
      .post(`/v1/node/${TASK}/release`)
      .send({ fence: 1, actorId: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQS" });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error.code, "invalid-request");
  });
});
