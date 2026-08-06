import { comparePaths } from "../../domain/plan-path.ts";

const isAbsentDirectory = (error: unknown): boolean =>
  (error as Readonly<{ code?: unknown }>).code === "ENOENT";

export type PlanDirectoryDependencies = Readonly<{
  readDirectory: (path: string) => readonly string[];
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  makeDirectory: (path: string) => void;
  removeFile: (path: string) => void;
}>;

const walkMarkdownPaths = (
  dependencies: PlanDirectoryDependencies,
  root: string,
): string[] => {
  const collect = (directory: string, prefix: string): string[] => {
    let names: readonly string[];
    try {
      names = dependencies.readDirectory(directory);
    } catch (error) {
      if (isAbsentDirectory(error)) {
        return [];
      }
      throw error;
    }
    const found: string[] = [];
    for (const name of names) {
      if (name.endsWith("/")) {
        const child = name.slice(0, -1);
        found.push(...collect(`${directory}/${child}`, `${prefix}/${child}`));
      } else if (name.endsWith(".md")) {
        found.push(`${prefix}/${name}`);
      }
    }
    return found;
  };
  return collect(`${root}/plan`, "plan");
};

export function readPlanDirectory(
  dependencies: PlanDirectoryDependencies,
  root: string,
): readonly Readonly<{ path: string; content: string }>[] {
  const paths = walkMarkdownPaths(dependencies, root).sort(comparePaths);
  return paths.map((path) => ({
    path,
    content: dependencies.readFile(`${root}/${path}`),
  }));
}

export function writePlanDirectory(
  dependencies: PlanDirectoryDependencies,
  input: Readonly<{
    root: string;
    documents: readonly Readonly<{ path: string; content: string }>[];
  }>,
): readonly string[] {
  const made = new Set<string>();
  for (const document of input.documents) {
    const segments = document.path.split("/");
    let directory = segments[0]!;
    if (!made.has(directory)) {
      made.add(directory);
      dependencies.makeDirectory(`${input.root}/${directory}`);
    }
    for (let index = 1; index < segments.length - 1; index += 1) {
      directory = `${directory}/${segments[index]!}`;
      if (!made.has(directory)) {
        made.add(directory);
        dependencies.makeDirectory(`${input.root}/${directory}`);
      }
    }
    dependencies.writeFile(`${input.root}/${document.path}`, document.content);
  }
  const named = new Set(input.documents.map((document) => document.path));
  const removed = walkMarkdownPaths(dependencies, input.root)
    .filter((path) => !named.has(path))
    .sort(comparePaths);
  for (const path of removed) {
    dependencies.removeFile(`${input.root}/${path}`);
  }
  return removed;
}
