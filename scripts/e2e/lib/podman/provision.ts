import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  cpSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { RunnerError } from "../errors.ts";
import { baseImageReference } from "./preflight.ts";
import { runLabel } from "./reclaim.ts";
import { removeTree } from "../resources.ts";
import type { PodmanExecutor } from "../driver/podman.ts";

// The assembled context is copied into an image, so node_modules must be a
// real directory tree. pnpm's default layout symlinks into a store outside it.
const HOISTED_LINKER = "node-linker=hoisted";

export type ProvisionResult = Readonly<{
  images: Readonly<{ product: string; fixture: string }>;
  productDigest: string;
  baseDigest: string;
  architecture: string;
}>;

const repoRoot = join(import.meta.dirname, "../../../../");

function extractTarball(tarballPath: string, destination: string): void {
  const archive = gunzipSync(readFileSync(tarballPath));
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const rawName = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
    const rawSize = header
      .toString("ascii", 124, 136)
      .replace(/\0.*$/s, "")
      .trim();
    const size = Number.parseInt(rawSize, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] ?? 0);

    offset += 512;

    if (typeFlag === "0" || typeFlag === "\0") {
      const relativeName = rawName.replace(/^[^/]+\//, "");
      if (relativeName.length > 0) {
        const targetPath = join(destination, relativeName);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, archive.subarray(offset, offset + size));
      }
    }

    offset += Math.ceil(size / 512) * 512;
  }
}

async function pnpmPack(
  executeHost: PodmanExecutor,
  destination: string,
): Promise<Readonly<{ tarballPath: string; digest: string }>> {
  const record = await executeHost([
    "pnpm",
    "pack",
    "--pack-destination",
    destination,
  ]);
  const lines = record.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const reported = lines[lines.length - 1] as string;
  const tarballPath = isAbsolute(reported)
    ? reported
    : join(destination, reported);
  const bytes = readFileSync(tarballPath);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { tarballPath, digest };
}

async function assembleProductContext(
  executeHost: PodmanExecutor,
  work: string,
  tarballPath: string,
): Promise<string> {
  const contextRoot = join(work, "product-context");
  const productContext = join(contextRoot, "product");
  mkdirSync(productContext, { recursive: true });
  extractTarball(tarballPath, productContext);
  copyFileSync(
    join(repoRoot, "pnpm-lock.yaml"),
    join(productContext, "pnpm-lock.yaml"),
  );
  writeFileSync(join(productContext, ".npmrc"), `${HOISTED_LINKER}\n`);
  const install = await executeHost(
    ["pnpm", "install", "--prod", "--ignore-scripts", "--frozen-lockfile"],
    undefined,
    productContext,
  );
  if (install.exitCode !== 0) {
    throw new RunnerError(
      "unavailable",
      `pnpm install --dir ${productContext} exited ${String(install.exitCode)}: ${install.stderr}`,
    );
  }
  cpSync(join(repoRoot, "scripts/e2e/podman/bin"), join(contextRoot, "bin"), {
    recursive: true,
  });
  return contextRoot;
}

async function assembleFixtureContext(
  executeHost: PodmanExecutor,
  work: string,
): Promise<string> {
  const fixtureContext = join(work, "fixture-context", "fixture");
  mkdirSync(fixtureContext, { recursive: true });
  cpSync(join(repoRoot, "scripts/e2e/fixture-remote"), fixtureContext, {
    recursive: true,
  });

  const mainPath = join(fixtureContext, "main.ts");
  const rewritten = readFileSync(mainPath, "utf8").replaceAll(
    "../../../test/helpers/remote/",
    "./test/helpers/remote/",
  );
  writeFileSync(mainPath, rewritten);

  cpSync(
    join(repoRoot, "test/helpers/remote"),
    join(fixtureContext, "test/helpers/remote"),
    { recursive: true },
  );

  writeFileSync(
    join(fixtureContext, "package.json"),
    `${JSON.stringify({ name: "kanthord-e2e-fixture", version: "1.0.0", private: true }, null, 2)}\n`,
  );
  writeFileSync(join(fixtureContext, ".npmrc"), `${HOISTED_LINKER}\n`);

  // The fixture declares no dependency, so there is nothing to lock and
  // nothing to fetch. The install stays hermetic without a lockfile.
  const install = await executeHost(
    ["pnpm", "install", "--prod", "--ignore-scripts"],
    undefined,
    fixtureContext,
  );
  if (install.exitCode !== 0) {
    throw new RunnerError(
      "unavailable",
      `pnpm install --dir ${fixtureContext} exited ${String(install.exitCode)}: ${install.stderr}`,
    );
  }
  return join(work, "fixture-context");
}

async function assertBaseImagePresent(
  execute: PodmanExecutor,
): Promise<string> {
  const record = await execute([
    "podman",
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    baseImageReference,
  ]);
  if (record.exitCode !== 0) {
    throw new RunnerError(
      "unavailable",
      `the base image ${baseImageReference} is not present; run: podman pull ${baseImageReference}`,
    );
  }
  return record.stdout.trim();
}

async function buildImage(
  execute: PodmanExecutor,
  runId: string,
  tag: string,
  containerfile: string,
  context: string,
): Promise<void> {
  const record = await execute([
    "podman",
    "build",
    "--pull=never",
    "--network",
    "none",
    "--tag",
    tag,
    "--label",
    `${runLabel}=${runId}`,
    "--file",
    containerfile,
    context,
  ]);
  if (record.exitCode !== 0) {
    throw new RunnerError(
      "unavailable",
      `podman build --tag ${tag} --file ${containerfile} exited ${String(record.exitCode)}: ${record.stderr}`,
    );
  }
}

async function inspectField(
  execute: PodmanExecutor,
  format: string,
  reference: string,
): Promise<string> {
  const record = await execute([
    "podman",
    "image",
    "inspect",
    "--format",
    format,
    reference,
  ]);
  return record.stdout.trim();
}

export async function provisionImages(
  execute: PodmanExecutor,
  executeHost: PodmanExecutor,
  runId: string,
): Promise<ProvisionResult> {
  const work = mkdtempSync(join(tmpdir(), "kanthord-e2e-provision-"));

  try {
    const { tarballPath, digest: productDigest } = await pnpmPack(
      executeHost,
      work,
    );
    const productContext = await assembleProductContext(
      executeHost,
      work,
      tarballPath,
    );
    const fixtureContext = await assembleFixtureContext(executeHost, work);

    const baseDigest = await assertBaseImagePresent(execute);

    const productTag = `kanthord-e2e-product:${runId}`;
    const fixtureTag = `kanthord-e2e-fixture:${runId}`;

    await buildImage(
      execute,
      runId,
      productTag,
      join(repoRoot, "scripts/e2e/podman/product.Containerfile"),
      productContext,
    );
    await buildImage(
      execute,
      runId,
      fixtureTag,
      join(repoRoot, "scripts/e2e/podman/fixture.Containerfile"),
      fixtureContext,
    );

    const productImage = await inspectField(execute, "{{.Id}}", productTag);
    const fixtureImage = await inspectField(execute, "{{.Id}}", fixtureTag);
    const architecture = await inspectField(
      execute,
      "{{.Architecture}}",
      productTag,
    );

    return {
      images: { product: productImage, fixture: fixtureImage },
      productDigest,
      baseDigest,
      architecture,
    };
  } finally {
    await removeTree(work);
  }
}
