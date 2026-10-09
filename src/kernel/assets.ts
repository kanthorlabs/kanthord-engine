import { readFileSync } from "node:fs";
import { getAsset, getAssetKeys, isSea } from "node:sea";

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
