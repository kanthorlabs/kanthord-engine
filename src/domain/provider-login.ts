import { z } from "zod";

import { identity } from "./identity.ts";
import { bytes, epochMillis } from "./column.ts";

export const providerLoginMethods = ["manual-code", "device-code"] as const;
export type ProviderLoginMethod = (typeof providerLoginMethods)[number];

export const providerLoginStates = ["pending", "completed"] as const;
export type ProviderLoginState = (typeof providerLoginStates)[number];

export const providerLoginRow = z.object({
  id: identity("providerLogin"),
  provider: z.string(),
  method: z.enum(providerLoginMethods),
  state: z.enum(providerLoginStates),
  instanceId: z.string(),
  payloadCiphertext: bytes.nullable(),
  payloadIv: bytes
    .refine((value) => value.length === 12, {
      message: "length(payload_iv) = 12",
    })
    .nullable(),
  payloadTag: bytes
    .refine((value) => value.length === 16, {
      message: "length(payload_tag) = 16",
    })
    .nullable(),
  keyVersion: z.int().nullable(),
  createdAt: epochMillis,
  expiresAt: epochMillis,
});
export type ProviderLoginRow = z.infer<typeof providerLoginRow>;
