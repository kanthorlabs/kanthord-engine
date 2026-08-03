import { z } from "zod";

import { identity } from "./identity.ts";
import { bytes, epochMillis } from "./column.ts";

export const providerRow = z.object({
  id: identity("provider"),
  name: z.string(),
  kind: z.enum(["llm", "git"]),
  setDefaultAt: epochMillis.nullable(),
  payloadCiphertext: bytes,
  payloadIv: bytes.refine((value) => value.length === 12, {
    message: "length(payload_iv) = 12",
  }),
  payloadTag: bytes.refine((value) => value.length === 16, {
    message: "length(payload_tag) = 16",
  }),
  keyVersion: z.int(),
  updatedAt: epochMillis,
});
export type ProviderRow = z.infer<typeof providerRow>;
