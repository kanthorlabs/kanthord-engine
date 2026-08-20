import { execFileSync } from "node:child_process";

import type { ReleaseFacts } from "./release-gate.ts";

export function readReleaseFacts(repositoryRoot: string): ReleaseFacts {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  const dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim().length > 0;
  const tags = execFileSync("git", ["tag", "--points-at", commit], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/)
    .filter((tag) => tag.length > 0);

  return { commit, dirty, tags };
}
