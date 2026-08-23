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
import {
  landingRefOf,
  publishRefOf,
  trackingRefOf,
} from "../../domain/repository.ts";

export type SeedHomeResult = Readonly<{
  homePath: string;
  fetchedUpstreamOid: string;
  landingOid: string;
}>;

export type SeedHomeExtended = SeedHomeInput &
  Readonly<{
    remoteUrl: string;
    hostKey: HostKey | null;
    pidFile: string;
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
  const staging = stagingPathFor(input.gitDir);
  try {
    if (input.hostKey !== null) {
      await trustHostKey(paths, {
        remoteUrl: input.remoteUrl,
        hostKey: input.hostKey,
      });
    }
    await runner({
      args: [
        "init",
        "--bare",
        "--template=",
        "--object-format=sha1",
        `--initial-branch=${input.branch}`,
        "--",
        staging,
      ],
    });
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
    await runner({
      args: [
        `--git-dir=${staging}`,
        "config",
        "remote.origin.fetch",
        TRACKING_REFSPEC,
      ],
    });
    await fetchTracking(runner, paths, {
      gitDir: staging,
      credential: input.credential,
      pidFile: input.pidFile,
    });
    rmSync(input.pidFile, { force: true });
    const upstreamOid = await resolveRef(runner, {
      gitDir: staging,
      ref: trackingRefOf(input.branch),
    });
    if (upstreamOid === null) {
      throw new GitError(
        "unknown",
        `the branch ${input.branch} does not exist on the remote`,
        "",
      );
    }
    const preflight = await canPush(runner, paths, {
      gitDir: staging,
      remoteUrl: input.remoteUrl,
      publishRef: publishRefOf(input.branch),
      proposedOid: upstreamOid,
      credential: input.credential,
    });
    if (!preflight.allowed) {
      throw new GitError(
        preflight.failure,
        `the credential may not push to ${publishRefOf(input.branch)}`,
        preflight.detail,
      );
    }
    const landing = await refUpdate(runner, {
      gitDir: staging,
      ref: landingRefOf(input.branch),
      expectedOid: null,
      nextOid: upstreamOid,
      pidFile: input.pidFile,
    });
    if (!landing.updated) {
      throw new GitError(
        "unknown",
        `${landingRefOf(input.branch)} already exists in the new home`,
        "",
      );
    }
    syncDirectory(staging);
    renameSync(staging, input.gitDir);
    syncDirectory(dirname(input.gitDir));
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
