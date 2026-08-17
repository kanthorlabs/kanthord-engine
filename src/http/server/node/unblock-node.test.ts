import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BOOTSTRAP_ACTOR_FIXTURE } from "../../../../test/helpers/app.ts";
import type { HandlerContext } from "../app.ts";
import { HttpError } from "../../contract/errors.ts";
import {
  UnblockNodeError,
  type UnblockNodeInput,
} from "../../../commands/node/unblock-node.ts";
import { unblockNodeHandler } from "./unblock-node.ts";

const TASK = "task_01JQ8Z7G3HZZZZZZZZZZZZZZZZ";

const result = {
  node: {
    id: TASK,
    state: "ready" as const,
  },
};

function context(
  body: unknown = undefined,
  id: string | undefined = TASK,
): HandlerContext {
  return {
    operation: {} as HandlerContext["operation"],
    parameters: id === undefined ? {} : { id },
    query: {},
    headers: {},
    body,
    actor: BOOTSTRAP_ACTOR_FIXTURE,
  };
}

describe("src/http/server/node/unblock-node.test", () => {
  it("each refusal maps to its declared status", async () => {
    const cases = [
      {
        error: new UnblockNodeError("not-found", "no node", undefined),
        status: 404,
        code: "not-found",
        details: undefined,
      },
      {
        error: new UnblockNodeError(
          "node-kind-invalid",
          "an objective cannot be unblocked",
        ),
        status: 400,
        code: "invalid-request",
        details: {
          refusal: "node-kind-invalid",
          blockReason: null,
        },
      },
      {
        error: new UnblockNodeError(
          "not-blocked",
          "the task is ready, not blocked",
          { state: "ready" },
        ),
        status: 409,
        code: "illegal-transition",
        details: {
          refusal: "not-blocked",
          blockReason: null,
        },
      },
      {
        error: new UnblockNodeError(
          "block-reason-not-clearable",
          "the block reason is not clearable",
          { blockReason: "dirty-recovery" },
        ),
        status: 409,
        code: "illegal-transition",
        details: {
          refusal: "block-reason-not-clearable",
          blockReason: "dirty-recovery",
        },
      },
    ] as const;

    for (const row of cases) {
      const handler = unblockNodeHandler({
        unblockNode: (_input: UnblockNodeInput) => {
          throw row.error;
        },
      });

      await assert.rejects(
        async () => await handler(context()),
        (error: unknown) => {
          assert.ok(error instanceof HttpError);
          assert.equal(error.status, row.status);
          assert.equal(error.code, row.code);
          if (row.details === undefined) {
            assert.equal(error.details, undefined);
          } else {
            assert.deepEqual(error.details, row.details);
          }
          return true;
        },
      );
    }
  });

  it("the handler parses, invokes once and formats", async () => {
    const received: UnblockNodeInput[] = [];
    const handler = unblockNodeHandler({
      unblockNode: (input) => {
        received.push(input);
        return result;
      },
    });

    const response = await handler(context());

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, result);
    assert.deepEqual(received, [
      {
        nodeId: TASK,
        actorId: BOOTSTRAP_ACTOR_FIXTURE.id,
        actorKind: "human",
      },
    ]);
  });
});
