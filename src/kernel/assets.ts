import { readFileSync } from "node:fs";
import { getAsset, isSea } from "node:sea";

export interface AssetSource {
  isSea(): boolean;
  getAsset(name: string, encoding: "utf8"): string;
}

const TEXT_ENCODING = "utf8";
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
