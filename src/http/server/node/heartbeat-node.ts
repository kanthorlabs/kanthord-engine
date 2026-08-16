import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { nodeHeartbeatRequest } from "../../contract/execution.ts";
import type { HeartbeatNodeInput } from "../../../commands/node/heartbeat-node.ts";
import { toHttpError } from "./refusals.ts";

export type HeartbeatNodeHandlerDependencies = Readonly<{
  heartbeatNode: (input: HeartbeatNodeInput) => unknown;
}>;

export function heartbeatNodeHandler(
  dependencies: HeartbeatNodeHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no node id in the request path");
    }
    const parsed = nodeHeartbeatRequest.safeParse(context.body);
    if (!parsed.success) {
      throw httpError("invalid-request", "the heartbeat body is invalid");
    }
    try {
      const result = dependencies.heartbeatNode({
        nodeId: id,
        fence: parsed.data.fence,
        actorId: context.actor.id,
        actorKind: context.actor.kind,
      });
      return { status: 200, body: result };
    } catch (error) {
      throw toHttpError(error, { subject: id, fence: parsed.data.fence });
    }
  };
}
