import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { nodeClaimRequest } from "../../contract/execution.ts";
import type { ClaimNodeInput } from "../../../commands/node/claim-node.ts";
import { toHttpError } from "./refusals.ts";

export type ClaimNodeHandlerDependencies = Readonly<{
  claimNode: (input: ClaimNodeInput) => unknown;
}>;

export function claimNodeHandler(
  dependencies: ClaimNodeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no node id in the request path");
    }
    const parsed = nodeClaimRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the claim body is invalid",
        parsed.error,
      );
    }
    try {
      const result = dependencies.claimNode({
        nodeId: id,
        actorId: context.actor.id,
        actorKind: context.actor.kind,
      });
      return { kind: "json", status: 200, body: result };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
