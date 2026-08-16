import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
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
      throw httpError("invalid-request", "the node filters are not valid");
    }
    const nodes = dependencies.listNodes(parsed.data);
    return { status: 200, body: { nodes } };
  };
}
