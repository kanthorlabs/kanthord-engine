import type { Handler } from "../app.ts";
import type { NodeListItem } from "../../../queries/node/list-node.ts";

export type ListNodeHandlerDependencies = Readonly<{
  listNodes: (
    input: Readonly<Record<string, never>>,
  ) => readonly NodeListItem[];
}>;

export function listNodeHandler(
  dependencies: ListNodeHandlerDependencies,
): Handler {
  return async () => {
    const nodes = dependencies.listNodes({});
    return { status: 200, body: { nodes } };
  };
}
