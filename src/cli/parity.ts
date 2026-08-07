import type { Command } from "commander";

export type CommandSetDifference = Readonly<{
  missingFromProgram: readonly string[];
  missingFromInventory: readonly string[];
}>;

export function programCommandPaths(program: Command): readonly string[] {
  const paths: string[] = [];
  collectLeafPaths(program, [], paths);
  return paths.sort(bytewise);
}

export function compareCommandSets(
  declared: readonly string[],
  actual: readonly string[],
): CommandSetDifference {
  const declaredSet = new Set(declared);
  const actualSet = new Set(actual);

  const missingFromProgram = declared
    .filter((path) => !actualSet.has(path))
    .sort(bytewise);

  const missingFromInventory = actual
    .filter((path) => !declaredSet.has(path))
    .sort(bytewise);

  return { missingFromProgram, missingFromInventory };
}

function collectLeafPaths(
  node: Command,
  ancestors: readonly string[],
  paths: string[],
): void {
  for (const child of node.commands) {
    if (child.commands.length === 0) {
      paths.push([...ancestors, child.name()].join(" "));
    } else {
      collectLeafPaths(child, [...ancestors, child.name()], paths);
    }
  }
}

function bytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
