import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  type BinaryAssetSource,
  PI_TOOLS_MANIFEST,
  piToolAsset,
  piToolCurrent,
  shippedAsset,
} from "../kernel/assets.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { PRIVATE_DIRECTORY_MODE } from "../kernel/files.ts";
import type { Row } from "../kernel/rows.ts";
import { WorkerErrorCode } from "../worker/contract.ts";
import { childEnvironment } from "./environment.ts";
import { piDirectory } from "./pi.ts";

const BIN_DIRECTORY_NAME = "bin";
const LICENSES_DIRECTORY_NAME = "licenses";
const BINARY_MODE = 0o755;
const LICENSE_MODE = 0o644;
const VERSION_TIMEOUT_MS = 10000;
const SUCCESS = 0;
const TEXT_BUSY = "ETXTBSY";
const TEXT_BUSY_ATTEMPTS = 20;
const TEXT_BUSY_WAIT_MS = 25;
const WAIT_CELL = 0;
const WAIT_VALUE = 0;

const targetSchema = z.strictObject({
  url: z.url(),
  archive_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  binary_path: z.string().min(1),
  binary_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  license_paths: z.array(z.string().min(1)),
});
export const piToolsManifestSchema = z.strictObject({
  tools: z.record(
    z.string().min(1),
    z.strictObject({
      version: z.string().min(1),
      repository: z.string().min(1),
      targets: z.record(z.string().min(1), targetSchema),
    }),
  ),
});
export type PiToolsManifest = z.infer<typeof piToolsManifestSchema>;
type PiToolTarget = z.infer<typeof targetSchema>;

export interface PiToolsOptions {
  env?: NodeJS.ProcessEnv;
  directory?: string;
  target?: string;
  manifest?: PiToolsManifest;
  assets?: BinaryAssetSource;
  root?: URL;
}

function toolMissing(
  tool: string,
  message: string,
  fields: readonly Row[] = [],
): Diagnostic {
  return new Diagnostic(WorkerErrorCode.StartToolMissing, `${message}.`, {
    fields: [["tool", tool], ...fields],
  });
}

function hasDigest(path: string, digest: string): boolean {
  try {
    return piToolCurrent(readFileSync(path), digest);
  } catch {
    return false;
  }
}

function publish(path: string, bytes: Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes);
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function runVersion(path: string, env: NodeJS.ProcessEnv) {
  const cell = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
  );
  const check = () =>
    spawnSync(path, ["--version"], {
      timeout: VERSION_TIMEOUT_MS,
      env: childEnvironment(env),
    });
  let run = check();
  for (
    let attempt = 1;
    attempt < TEXT_BUSY_ATTEMPTS &&
    (run.error as NodeJS.ErrnoException | undefined)?.code === TEXT_BUSY;
    attempt++
  ) {
    Atomics.wait(cell, WAIT_CELL, WAIT_VALUE, TEXT_BUSY_WAIT_MS);
    run = check();
  }
  return run;
}

function installTool(
  tool: string,
  entry: PiToolTarget,
  target: string,
  binDirectory: string,
  options: PiToolsOptions,
): void {
  const binary = piToolAsset(
    target,
    `${BIN_DIRECTORY_NAME}/${tool}`,
    options.assets,
    options.root,
  );
  if (!binary) throw toolMissing(tool, "binary source is absent");
  if (!piToolCurrent(binary, entry.binary_sha256))
    throw toolMissing(tool, "binary digest differs from the manifest");
  const path = join(binDirectory, tool);
  try {
    if (!hasDigest(path, entry.binary_sha256))
      publish(path, binary, BINARY_MODE);
    for (const license of entry.license_paths) {
      const file = basename(license);
      const bytes = piToolAsset(
        target,
        `${LICENSES_DIRECTORY_NAME}/${tool}/${file}`,
        options.assets,
        options.root,
      );
      if (!bytes)
        throw toolMissing(tool, "license source is absent", [
          ["license", file],
        ]);
      publish(
        join(binDirectory, LICENSES_DIRECTORY_NAME, tool, file),
        bytes,
        LICENSE_MODE,
      );
    }
  } catch (error) {
    if (error instanceof Diagnostic) throw error;
    throw toolMissing(tool, "cannot install", [
      ["reason", (error as Error).message],
    ]);
  }
  const run = runVersion(path, options.env ?? process.env);
  if (run.error || run.status !== SUCCESS)
    throw toolMissing(tool, "cannot run", [
      ["reason", run.error?.message],
      ["exit_status", run.status],
    ]);
}

export function installPiTools(options: PiToolsOptions = {}): void {
  const target = options.target ?? `${process.platform}-${process.arch}`;
  const manifest =
    options.manifest ??
    piToolsManifestSchema.parse(JSON.parse(shippedAsset(PI_TOOLS_MANIFEST)));
  const binDirectory = join(
    options.directory ?? piDirectory(options.env ?? process.env),
    BIN_DIRECTORY_NAME,
  );
  for (const [tool, definition] of Object.entries(manifest.tools)) {
    const entry = definition.targets[target];
    if (!entry)
      throw toolMissing(tool, "host target is not in the manifest", [
        ["target", target],
      ]);
    installTool(tool, entry, target, binDirectory, options);
  }
}
