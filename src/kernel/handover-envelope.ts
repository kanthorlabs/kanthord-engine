import { z } from "zod";

export const handoverEnvelopeSchema = z.strictObject({
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
});
export type HandoverEnvelope = z.infer<typeof handoverEnvelopeSchema>;
