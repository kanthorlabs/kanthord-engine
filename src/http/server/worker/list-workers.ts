import type { Handler } from "../app.ts";
import type {
  ListWorkersInput,
  WorkerListItem,
} from "../../../queries/worker/list-workers.ts";

export type ListWorkerHandlerDependencies = Readonly<{
  listWorkers: (input: ListWorkersInput) => readonly WorkerListItem[];
}>;

export function listWorkerHandler(
  dependencies: ListWorkerHandlerDependencies,
): Handler {
  return () => {
    const workers = dependencies.listWorkers({});
    return { kind: "json", status: 200, body: { workers } };
  };
}
