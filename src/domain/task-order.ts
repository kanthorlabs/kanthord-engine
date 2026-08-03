export type DependencyEdge = Readonly<{
  from: string;
  to: string;
  waived: boolean;
}>;

export type TaskOrderInput = Readonly<{
  tasks: readonly string[];
  edges: readonly DependencyEdge[];
}>;

export type TaskOrderErrorCode =
  | "task-order-cycle"
  | "task-order-unknown-task"
  | "task-order-duplicate-task"
  | "task-order-duplicate-edge";

export class TaskOrderError extends Error {
  readonly code: TaskOrderErrorCode;

  constructor(code: TaskOrderErrorCode, message: string) {
    super(message);
    this.name = "TaskOrderError";
    this.code = code;
  }
}

export function taskOrder(input: TaskOrderInput): readonly string[] {
  const { tasks, edges } = input;

  const seen = new Set<string>();
  for (const id of tasks) {
    if (seen.has(id)) {
      throw new TaskOrderError(
        "task-order-duplicate-task",
        `${id} appears twice`,
      );
    }
    seen.add(id);
  }

  const taskSet = new Set(tasks);

  const seenPairs = new Set<string>();
  for (const edge of edges) {
    if (!taskSet.has(edge.from)) {
      throw new TaskOrderError(
        "task-order-unknown-task",
        `${edge.from} is not a task of this objective`,
      );
    }
    if (!taskSet.has(edge.to)) {
      throw new TaskOrderError(
        "task-order-unknown-task",
        `${edge.to} is not a task of this objective`,
      );
    }
    const pairKey = `${edge.from}->${edge.to}`;
    if (seenPairs.has(pairKey)) {
      throw new TaskOrderError(
        "task-order-duplicate-edge",
        `${edge.from} -> ${edge.to} appears twice`,
      );
    }
    seenPairs.add(pairKey);
  }

  const activeEdges = edges.filter((e) => !e.waived);

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of tasks) {
    inDegree.set(id, 0);
    dependents.set(id, []);
  }
  for (const edge of activeEdges) {
    inDegree.set(edge.from, (inDegree.get(edge.from) ?? 0) + 1);
    dependents.get(edge.to)!.push(edge.from);
  }

  const available: string[] = [];
  for (const id of tasks) {
    if (inDegree.get(id) === 0) {
      available.push(id);
    }
  }
  available.sort();

  const result: string[] = [];
  while (available.length > 0) {
    const current = available.shift()!;
    result.push(current);
    for (const dep of dependents.get(current)!) {
      const newDegree = inDegree.get(dep)! - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) {
        insertSorted(available, dep);
      }
    }
  }

  if (result.length < tasks.length) {
    throw new TaskOrderError(
      "task-order-cycle",
      "the dependency graph holds a cycle",
    );
  }

  return result;
}

function insertSorted(arr: string[], value: string): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  arr.splice(lo, 0, value);
}
