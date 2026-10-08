import { readFileSync } from "node:fs";
import { getAsset, isSea } from "node:sea";

export interface AssetSource {
  isSea(): boolean;
  getAsset(name: string, encoding: "utf8"): string;
}

const TEXT_ENCODING = "utf8";
export const PACKAGE_MANIFEST = "package.json";
const nodeAssetSource: AssetSource = { isSea, getAsset };

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
