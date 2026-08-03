import { z } from "zod";

import { bytes, epochMillis } from "./column.ts";

export const blobHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const blobRow = z.object({
  hash: blobHash,
  size: z.int(),
  content: bytes,
  createdAt: epochMillis,
});
export type BlobRow = z.infer<typeof blobRow>;
