import assert from "node:assert/strict";
import type { SimpleGitOptions } from "simple-git";

const EMPTY_CONFIG_PATH = "/dev/null";
const DEFAULT_IDENTITY = {
  GIT_AUTHOR_NAME: "kanthord",
  GIT_AUTHOR_EMAIL: "kanthord@localhost",
  GIT_COMMITTER_NAME: "kanthord",
  GIT_COMMITTER_EMAIL: "kanthord@localhost",
} as const;
const INTERACTIVE_HELPERS = [
  "PAGER",
  "GIT_PAGER",
  "EDITOR",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
];
const ISOLATION = {
  GIT_CONFIG_GLOBAL: EMPTY_CONFIG_PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.excludesFile",
  GIT_CONFIG_VALUE_0: EMPTY_CONFIG_PATH,
} as const;

export const GIT_UNSAFE_OPTIONS: NonNullable<SimpleGitOptions["unsafe"]> = {
  allowUnsafeConfigPaths: true,
  allowUnsafeConfigEnvCount: true,
  allowUnsafeSshCommand: true,
};

export function isolatedGitEnvironment(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  assert.ok(env);
  const output: NodeJS.ProcessEnv = { ...env };
  for (const name of INTERACTIVE_HELPERS) delete output[name];
  for (const [name, value] of Object.entries(DEFAULT_IDENTITY))
    if (!output[name]) output[name] = value;
  return { ...output, ...ISOLATION };
}
