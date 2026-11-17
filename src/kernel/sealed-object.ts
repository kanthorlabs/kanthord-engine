import { z } from "zod";

export const SEALED_ALGORITHM = "hpke-x25519-sha256-aes128gcm";

export const base64urlPattern = /^[A-Za-z0-9_-]+$/;
export const base64urlSchema = z.string().min(1).regex(base64urlPattern);

export const sealedObjectSchema = z.strictObject({
  alg: z.literal(SEALED_ALGORITHM),
  enc: base64urlSchema,
  ciphertext: base64urlSchema,
});
export type SealedObject = z.infer<typeof sealedObjectSchema>;
