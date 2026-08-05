import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  GitError,
  TRACKING_REFSPEC,
  type GitPaths,
  type HostKey,
  type SeedHomeInput,
} from "./index.ts";
import { fetchTracking } from "./fetch.ts";
import { trustHostKey } from "./host-key.ts";
import { canPush } from "./preflight.ts";
import { resolveRef } from "./ref-read.ts";
import { refUpdate } from "./ref-update.ts";
import { remoteUrlVerdict } from "./url.ts";
import type { GitRunner } from "./run.ts";

export type SeedHomeResult = Readonly<{
  homePath: string;
  fetchedUpstreamOid: string;
  landingOid: string;
}>;

export type SeedStep =
  | "host-key"
  | "init"
  | "remote-add"
  | "refspec"
  | "fetch"
  | "read-upstream"
  | "preflight"
  | "landing"
  | "rename";

export type SeedHomeExtended = SeedHomeInput &
  Readonly<{
    publishRef: string;
    remoteUrl: string;
    hostKey: HostKey | null;
    pidFile: string;
    failAfter?: SeedStep;
  }>;

export function stagingPathFor(gitDir: string): string {
  return join(dirname(gitDir), `.staging-${randomUUID()}`);
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function seedHome(
  runner: GitRunner,
  paths: GitPaths,
  input: SeedHomeExtended,
): Promise<SeedHomeResult> {
  if (existsSync(input.gitDir)) {
    throw new GitError("unknown", "the repository home already exists", "");
  }
  const verdict = remoteUrlVerdict(input.remoteUrl);
  if (!verdict.allowed) {
    throw new GitError("url-refused", verdict.reason, "");
  }
  if (verdict.transport !== input.credential.transport) {
    throw new GitError(
      "url-refused",
      "the url transport and the credential transport disagree",
      "",
    );
  }
  const abort = (step: SeedStep): void => {
    if (input.failAfter === step) {
      throw new GitError("unknown", `seed aborted after ${step}`, "");
    }
  };
  const staging = stagingPathFor(input.gitDir);
  try {
    if (input.hostKey !== null) {
      await trustHostKey(paths, {
        remoteUrl: input.remoteUrl,
        hostKey: input.hostKey,
      });
      abort("host-key");
    }
    await runner({
      args: [
        "init",
        "--bare",
        "--template=",
        "--object-format=sha1",
        `--initial-branch=${input.landingBranch}`,
        "--",
        staging,
      ],
    });
    abort("init");
    await runner({
      args: [
        `--git-dir=${staging}`,
        "remote",
        "add",
        "origin",
        "--",
        input.remoteUrl,
      ],
    });
    abort("remote-add");
    await runner({
      args: [
        `--git-dir=${staging}`,
        "config",
        "remote.origin.fetch",
        TRACKING_REFSPEC,
      ],
    });
    abort("refspec");
    await fetchTracking(runner, paths, {
      gitDir: staging,
      credential: input.credential,
      pidFile: input.pidFile,
    });
    abort("fetch");
    rmSync(input.pidFile, { force: true });
    const upstreamOid = await resolveRef(runner, {
      gitDir: staging,
      ref: `refs/remotes/origin/${input.upstreamBranch}`,
    });
    if (upstreamOid === null) {
      throw new GitError(
        "unknown",
        `the branch ${input.upstreamBranch} does not exist on the remote`,
        "",
      );
    }
    abort("read-upstream");
    const preflight = await canPush(runner, paths, {
      gitDir: staging,
      remoteUrl: input.remoteUrl,
      publishRef: input.publishRef,
      proposedOid: upstreamOid,
      credential: input.credential,
    });
    if (!preflight.allowed) {
      throw new GitError(
        preflight.failure,
        `the credential may not push to ${input.publishRef}`,
        preflight.detail,
      );
    }
    abort("preflight");
    const landing = await refUpdate(runner, {
      gitDir: staging,
      ref: `refs/heads/${input.landingBranch}`,
      expectedOid: null,
      nextOid: upstreamOid,
      pidFile: input.pidFile,
    });
    if (!landing.updated) {
      throw new GitError(
        "unknown",
        `refs/heads/${input.landingBranch} already exists in the new home`,
        "",
      );
    }
    abort("landing");
    syncDirectory(staging);
    renameSync(staging, input.gitDir);
    syncDirectory(dirname(input.gitDir));
    abort("rename");
    return {
      homePath: input.gitDir,
      fetchedUpstreamOid: upstreamOid,
      landingOid: upstreamOid,
    };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}
