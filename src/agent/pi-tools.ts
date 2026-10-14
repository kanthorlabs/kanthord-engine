import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
  piToolAsset,
  shippedAsset,
  type BinaryAssetSource,
} from "../kernel/assets.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { PRIVATE_DIRECTORY_MODE } from "../kernel/files.ts";
import { WorkerErrorCode } from "../worker/contract.ts";
import { childEnvironment } from "./environment.ts";
import { piDirectory } from "./pi.ts";

export const PI_TOOLS_MANIFEST = "pi-tools.json";
const BIN_DIRECTORY_NAME = "bin";
const LICENSES_DIRECTORY_NAME = "licenses";
const BINARY_MODE = 0o755;
const LICENSE_MODE = 0o644;
const VERSION_TIMEOUT_MS = 10000;
const SUCCESS = 0;

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
  target?: string;
  manifest?: PiToolsManifest;
  assets?: BinaryAssetSource;
  root?: URL;
}

function toolMissing(tool: string, reason: string): Diagnostic {
  return new Diagnostic(
    WorkerErrorCode.StartToolMissing,
    `${tool}: ${reason}.`,
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasDigest(path: string, digest: string): boolean {
  try {
    return sha256(readFileSync(path)) === digest;
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
  if (sha256(binary) !== entry.binary_sha256)
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
      if (!bytes) throw toolMissing(tool, `license ${file} source is absent`);
      publish(
        join(binDirectory, LICENSES_DIRECTORY_NAME, tool, file),
        bytes,
        LICENSE_MODE,
      );
    }
  } catch (error) {
    if (error instanceof Diagnostic) throw error;
    throw toolMissing(tool, `cannot install: ${(error as Error).message}`);
  }
  const run = spawnSync(path, ["--version"], {
    timeout: VERSION_TIMEOUT_MS,
    env: childEnvironment(process.env),
  });
  if (run.error || run.status !== SUCCESS)
    throw toolMissing(
      tool,
      `cannot run: ${run.error?.message ?? `exit status ${run.status}`}`,
    );
}

export function installPiTools(options: PiToolsOptions = {}): void {
  const target = options.target ?? `${process.platform}-${process.arch}`;
  const manifest =
    options.manifest ??
    piToolsManifestSchema.parse(JSON.parse(shippedAsset(PI_TOOLS_MANIFEST)));
  const binDirectory = join(
    piDirectory(options.env ?? process.env),
    BIN_DIRECTORY_NAME,
  );
  for (const [tool, definition] of Object.entries(manifest.tools)) {
    const entry = definition.targets[target];
    if (!entry)
      throw toolMissing(tool, `host target ${target} is not in the manifest`);
    installTool(tool, entry, target, binDirectory, options);
  }
}
