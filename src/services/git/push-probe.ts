import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TRACKING_REFSPEC,
  type GitPaths,
  type ProbePushInput,
  type PushPreflight,
} from "./index.ts";
import { fetchTracking } from "./fetch.ts";
import { canPush } from "./preflight.ts";
import { resolveRef } from "./ref-read.ts";
import type { GitRunner } from "./run.ts";
import { publishRefOf, trackingRefOf } from "../../domain/repository.ts";

export async function probePush(
  runner: GitRunner,
  paths: GitPaths,
  input: ProbePushInput,
): Promise<PushPreflight> {
  if (input.branch === null) {
    return { allowed: false, failure: "empty-remote", detail: "" };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "kanthord-probe-"));
  const probePaths: GitPaths = {
    ...paths,
    keyDirectory: join(tempDir, "keys"),
    runDirectory: join(tempDir, "run"),
  };

  try {
    await runner({
      args: [
        "init",
        "--bare",
        "--template=",
        "--object-format=sha1",
        `--initial-branch=${input.branch}`,
        "--",
        tempDir,
      ],
    });
    await runner({
      args: [
        `--git-dir=${tempDir}`,
        "remote",
        "add",
        "origin",
        "--",
        input.remoteUrl,
      ],
    });
    await runner({
      args: [
        `--git-dir=${tempDir}`,
        "config",
        "remote.origin.fetch",
        TRACKING_REFSPEC,
      ],
    });
    await fetchTracking(runner, probePaths, {
      gitDir: tempDir,
      credential: input.credential,
      pidFile: join(tempDir, "fetch" + ".pid"),
    });
    const upstreamOid = await resolveRef(runner, {
      gitDir: tempDir,
      ref: trackingRefOf(input.branch),
    });
    if (upstreamOid === null) {
      return {
        allowed: false,
        failure: "unknown",
        detail: `tracking ref ${trackingRefOf(input.branch)} not found after fetch`,
      };
    }
    return await canPush(runner, probePaths, {
      gitDir: tempDir,
      remoteUrl: input.remoteUrl,
      publishRef: publishRefOf(input.branch),
      proposedOid: upstreamOid,
      credential: input.credential,
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
