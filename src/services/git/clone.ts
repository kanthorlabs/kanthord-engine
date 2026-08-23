import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { GitError, type CloneInput } from "./index.ts";
import { stripUserinfo } from "./redact.ts";
import type { GitRunner } from "./run.ts";
import { featureBranchOf, featureRefOf } from "../../domain/repository.ts";

export async function cloneObjective(
  runner: GitRunner,
  input: CloneInput,
): Promise<string> {
  if (existsSync(input.targetDir)) {
    throw new GitError("unknown", `${input.targetDir} already exists`, "");
  }
  const parent = dirname(input.targetDir);
  mkdirSync(parent, { recursive: true });
  const staging = join(parent, `.staging-${randomUUID()}`);
  try {
    const featureBranch = featureBranchOf(input.objectiveId);
    const cloneResult = await runner({
      args: [
        "clone",
        "--no-hardlinks",
        "--no-local",
        "--branch",
        input.ref,
        "--",
        input.sourceGitDir,
        staging,
      ],
    });
    if (cloneResult.code !== 0) {
      throw new GitError(
        "unknown",
        `git clone failed with code ${cloneResult.code}`,
        stripUserinfo(cloneResult.stderr),
      );
    }
    const branchResult = await runner({
      args: ["-C", staging, "checkout", "-b", featureBranch],
    });
    if (branchResult.code !== 0) {
      throw new GitError(
        "unknown",
        `git checkout -b failed with code ${branchResult.code}`,
        stripUserinfo(branchResult.stderr),
      );
    }
    const removeResult = await runner({
      args: ["-C", staging, "remote", "remove", "origin"],
    });
    if (removeResult.code !== 0) {
      throw new GitError(
        "unknown",
        `git remote remove failed with code ${removeResult.code}`,
        stripUserinfo(removeResult.stderr),
      );
    }
    const remoteResult = await runner({ args: ["-C", staging, "remote"] });
    if (remoteResult.code !== 0) {
      throw new GitError(
        "unknown",
        `git remote failed with code ${remoteResult.code}`,
        stripUserinfo(remoteResult.stderr),
      );
    }
    if (remoteResult.stdout.trim() !== "") {
      throw new GitError("unknown", "the clone still carries a remote", "");
    }
    if (existsSync(join(staging, ".git", "objects", "info", "alternates"))) {
      throw new GitError(
        "unknown",
        "the clone carries objects/info/alternates",
        "",
      );
    }
    const promisorResult = await runner({
      args: [
        "-C",
        staging,
        "config",
        "--get-regexp",
        "^(remote\\..*\\.(promisor|partialclonefilter)|extensions\\.partialclone)$",
      ],
    });
    if (promisorResult.code === 0 || promisorResult.stdout.trim() !== "") {
      throw new GitError(
        "unknown",
        "the clone carries a partial-clone configuration",
        "",
      );
    }
    const headResult = await runner({
      args: ["-C", staging, "symbolic-ref", "--quiet", "HEAD"],
    });
    const expectedRef = featureRefOf(input.objectiveId);
    if (headResult.code !== 0) {
      throw new GitError(
        "unknown",
        `the clone has no symbolic HEAD; git symbolic-ref exited ${headResult.code}`,
        stripUserinfo(headResult.stderr),
      );
    }
    if (headResult.stdout.trim() !== expectedRef) {
      throw new GitError(
        "unknown",
        `the clone HEAD is ${headResult.stdout.trim()} and not ${expectedRef}`,
        "",
      );
    }
    renameSync(staging, input.targetDir);
    return input.targetDir;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
