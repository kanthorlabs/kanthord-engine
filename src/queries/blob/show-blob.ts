import type { BlobStore } from "../../services/blob/index.ts";

export type ShowBlobDependencies = Readonly<{
  blobs: BlobStore;
}>;

export type BlobView = Readonly<{
  hash: string;
  size: number;
  content: Uint8Array;
  createdAt: number;
}>;

export function showBlob(
  dependencies: ShowBlobDependencies,
  input: Readonly<{ hash: string }>,
): BlobView | null {
  return dependencies.blobs.get(input.hash);
}
