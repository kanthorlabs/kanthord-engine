import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { nodeListQuery } from "../../contract/graph.ts";
import { singleValued } from "../single.ts";
import type {
  NodeListFilter,
  NodeListItem,
} from "../../../queries/node/list-node.ts";

export type ListNodeHandlerDependencies = Readonly<{
  listNodes: (input: NodeListFilter) => readonly NodeListItem[];
}>;

export function listNodeHandler(
  dependencies: ListNodeHandlerDependencies,
): Handler {
  return (context) => {
    const parsed = nodeListQuery.safeParse(singleValued(context.query));
    if (!parsed.success) {
      throw invalidRequest(
        "query-schema",
        "the node filters are not valid",
        parsed.error,
      );
    }
    const nodes = dependencies.listNodes(parsed.data);
    return { kind: "json", status: 200, body: { nodes } };
  };
}
