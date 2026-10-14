import { readFileSync } from "node:fs";
import { getAsset, getAssetKeys, isSea } from "node:sea";
import { FILE_NOT_FOUND } from "./files.ts";

export interface AssetSource {
  isSea(): boolean;
  getAsset(name: string, encoding: "utf8"): string;
}

export interface BinaryAssetSource {
  isSea(): boolean;
  getAssetKeys(): string[];
  getAsset(name: string): ArrayBuffer;
}

const TEXT_ENCODING = "utf8";
export const PACKAGE_MANIFEST = "package.json";
export const DASHBOARD_ASSET_PREFIX = "dashboard/";
export const PI_TOOLS_ASSET_PREFIX = "pi-tools/";
export const WORKER_THREAD_ASSET = "worker-thread.cjs";
const PI_TOOLS_DIRECTORY = new URL("../../.pi-tools/", import.meta.url);
const nodeAssetSource: AssetSource = { isSea, getAsset };
const nodeBinaryAssetSource: BinaryAssetSource = {
  isSea,
  getAssetKeys,
  getAsset: (name) => getAsset(name),
};

export function shippedAsset(
  name: string,
  source: AssetSource = nodeAssetSource,
): string {
  if (source.isSea()) return source.getAsset(name, TEXT_ENCODING);
  return readFileSync(
    new URL(`../../static/${name}`, import.meta.url),
    TEXT_ENCODING,
  );
}

export function packageManifest(source: AssetSource = nodeAssetSource): string {
  if (source.isSea()) return source.getAsset(PACKAGE_MANIFEST, TEXT_ENCODING);
  return readFileSync(
    new URL(`../../${PACKAGE_MANIFEST}`, import.meta.url),
    TEXT_ENCODING,
  );
}

export function workerThreadAsset(
  source: AssetSource = nodeAssetSource,
): string | undefined {
  return source.isSea()
    ? source.getAsset(WORKER_THREAD_ASSET, TEXT_ENCODING)
    : undefined;
}

export function dashboardAsset(
  path: string,
  source: BinaryAssetSource = nodeBinaryAssetSource,
): ArrayBuffer | undefined {
  if (!source.isSea()) return undefined;
  const name = `${DASHBOARD_ASSET_PREFIX}${path}`;
  return source.getAssetKeys().includes(name)
    ? source.getAsset(name)
    : undefined;
}

export function piToolAsset(
  target: string,
  path: string,
  source: BinaryAssetSource = nodeBinaryAssetSource,
  directory: URL = PI_TOOLS_DIRECTORY,
): Buffer | undefined {
  if (source.isSea()) {
    const name = `${PI_TOOLS_ASSET_PREFIX}${path}`;
    return source.getAssetKeys().includes(name)
      ? Buffer.from(source.getAsset(name))
      : undefined;
  }
  try {
    return readFileSync(new URL(`${target}/${path}`, directory));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND)
      return undefined;
    throw error;
  }
}
