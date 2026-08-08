import type { Storage } from "../../services/storage/index.ts";

export type ReadProjectStatusDependencies = Readonly<{ storage: Storage }>;

export type ProjectNodeCountLine = Readonly<{
  kind: string;
  state: string;
  blockReason: string | null;
  count: number;
}>;

export type ReadProjectStatusResult = Readonly<{
  nodes: readonly ProjectNodeCountLine[];
}>;

export function readProjectStatus(
  dependencies: ReadProjectStatusDependencies,
  input: Readonly<{ id: string }>,
): ReadProjectStatusResult | null {
  return dependencies.storage.transact((transaction) => {
    const project = transaction.get("SELECT id FROM project WHERE id = ?", [
      input.id,
    ]) as Readonly<{ id: string }> | undefined;
    if (project === undefined) {
      return null;
    }
    const nodes: ProjectNodeCountLine[] = [];
    for (const row of transaction.all(
      `SELECT kind AS kind, state AS state, block_reason AS blockReason, COUNT(*) AS count
FROM node
WHERE project_id = ?
GROUP BY kind, state, block_reason
ORDER BY kind ASC, state ASC, block_reason ASC`,
      [input.id],
    )) {
      nodes.push(row as ProjectNodeCountLine);
    }
    return { nodes };
  });
}
