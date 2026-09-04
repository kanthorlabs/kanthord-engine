import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type {
  UnblockNodeInput,
  UnblockNodeResult,
} from "../../../commands/node/unblock-node.ts";
import { UnblockNodeError } from "../../../commands/node/unblock-node.ts";

export type UnblockNodeHandlerDependencies = Readonly<{
  unblockNode: (input: UnblockNodeInput) => UnblockNodeResult;
}>;

export function unblockNodeHandler(
  dependencies: UnblockNodeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no node id in the request path");
    }
    try {
      const result = dependencies.unblockNode({
        nodeId: id,
        actorId: context.actor.id,
        actorKind: context.actor.kind,
      });
      return { kind: "json", status: 200, body: result };
    } catch (error) {
      if (error instanceof UnblockNodeError) {
        throw toHttpError(error);
      }
      throw error;
    }
  };
}

function toHttpError(error: UnblockNodeError) {
  switch (error.refusal) {
    case "actor-forbidden":
      return httpError("actor-forbidden", error.message);
    case "not-found":
      return httpError("not-found", error.message);
    case "node-kind-invalid":
      return httpError("invalid-request", error.message, {
        refusal: "node-kind-invalid",
        blockReason: null,
      });
    case "not-blocked":
      return httpError("illegal-transition", error.message, {
        refusal: "not-blocked",
        blockReason: null,
      });
    case "block-reason-not-clearable":
      return httpError("illegal-transition", error.message, {
        refusal: "block-reason-not-clearable",
        blockReason: error.details?.["blockReason"] ?? null,
      });
    case "subtree-busy":
      return httpError("subtree-busy", error.message, error.details ?? {});
  }
}
