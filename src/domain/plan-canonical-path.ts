import { parseIdentity } from "./identity.ts";
import { comparePaths } from "./plan-path.ts";
import { slug } from "./plan-slug.ts";
import type { NodeKind } from "./state.ts";
import { taskOrder } from "./task-order.ts";

export type CanonicalNode = Readonly<{
  identity: string;
  kind: NodeKind;
  title: string;
  parentIdentity: string | null;
  dependencies: readonly string[];
}>;

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

export function canonicalPaths(
  nodes: readonly CanonicalNode[],
): ReadonlyMap<string, string> {
  const segmentOf = (node: CanonicalNode): string =>
    `${slug(node.title)}--${parseIdentity(node.identity)!.ulid.toLowerCase()}`;

  const initiatives = nodes
    .filter((node) => node.kind === "initiative")
    .sort((left, right) => comparePaths(left.identity, right.identity));
  const objectives = nodes
    .filter((node) => node.kind === "objective")
    .sort((left, right) => comparePaths(left.identity, right.identity));
  const tasks = nodes
    .filter((node) => node.kind === "task")
    .sort((left, right) => comparePaths(left.identity, right.identity));

  const paths = new Map<string, string>();

  for (const node of initiatives) {
    paths.set(node.identity, `plan/${segmentOf(node)}/initiative.md`);
  }
  for (const node of objectives) {
    const parent = paths.get(node.parentIdentity ?? "");
    const directory = parent === undefined ? "" : directoryOf(parent);
    paths.set(node.identity, `${directory}/${segmentOf(node)}/objective.md`);
  }

  const groups = new Map<string, CanonicalNode[]>();
  for (const node of tasks) {
    const key = node.parentIdentity ?? "";
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }

  const ordinals = new Map<string, string>();
  for (const group of groups.values()) {
    const ids = group.map((node) => node.identity);
    const idSet = new Set(ids);
    const edges = group.flatMap((node) =>
      node.dependencies
        .filter((dependency) => idSet.has(dependency))
        .map((dependency) => ({
          from: node.identity,
          to: dependency,
          waived: false,
        })),
    );
    const width = Math.max(2, String(ids.length).length);
    taskOrder({ tasks: ids, edges }).forEach((id, index) => {
      ordinals.set(id, String(index + 1).padStart(width, "0"));
    });
  }

  for (const node of tasks) {
    const parent = paths.get(node.parentIdentity ?? "");
    const directory = parent === undefined ? "" : directoryOf(parent);
    const ordinal = ordinals.get(node.identity) ?? "01";
    paths.set(node.identity, `${directory}/${ordinal}-${segmentOf(node)}.md`);
  }

  return paths;
}
