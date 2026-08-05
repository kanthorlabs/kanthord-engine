import { dirname } from "node:path";

import type { GitPaths } from "./index.ts";

export const GIT_CONFIG_ARGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
];

export type GitEnvironmentInput = Readonly<{
  paths: GitPaths;
  extra?: Readonly<Record<string, string>>;
}>;

const pinnedNames: readonly string[] = [
  "PATH",
  "HOME",
  "LC_ALL",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_TERMINAL_PROMPT",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

function isSuppressedName(name: string): boolean {
  return (
    name === "GIT_DIR" ||
    name === "GIT_WORK_TREE" ||
    name === "GIT_CONFIG_COUNT" ||
    name.startsWith("GIT_TRACE")
  );
}

export function gitPath(paths: GitPaths): string {
  const directories: string[] = [];
  for (const binary of [paths.git, paths.ssh, paths.sshKeyscan]) {
    const directory = dirname(binary);
    if (!directories.includes(directory)) {
      directories.push(directory);
    }
  }
  return directories.join(":");
}

export function gitEnvironment(
  input: GitEnvironmentInput,
): Readonly<Record<string, string>> {
  const extra = input.extra ?? {};
  for (const name of Object.keys(extra)) {
    if (pinnedNames.includes(name)) {
      throw new Error(`${name} is a pinned entry`);
    }
    if (isSuppressedName(name)) {
      throw new Error(`${name} is a suppressed entry`);
    }
  }
  return {
    PATH: gitPath(input.paths),
    HOME: input.paths.home,
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "kanthord",
    GIT_AUTHOR_EMAIL: "kanthord@kanthord.invalid",
    GIT_COMMITTER_NAME: "kanthord",
    GIT_COMMITTER_EMAIL: "kanthord@kanthord.invalid",
    ...extra,
  };
}

export function gitArgv(args: readonly string[]): readonly string[] {
  return [...GIT_CONFIG_ARGS, ...args];
}
