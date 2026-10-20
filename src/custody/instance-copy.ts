import type { Credential } from "@earendil-works/pi-ai";
import type { z } from "zod";
import {
  openJSON,
  sealJSON,
  SealedOpenError,
  type SealedObject,
} from "../kernel/hpke.ts";
import { digest } from "../kernel/json.ts";
import {
  CREDENTIAL_SEAL_INFO,
  credentialSealAad,
  type piCredentialSchema,
  type SealedHandoverItem,
  type SecretShape,
  type WireReport,
} from "./contract.ts";
import {
  credentialOfSecret,
  normalizeCredential,
  secretOfCredential,
} from "./payload.ts";

export interface InstanceCopyKey {
  holder: string;
  sealed_to: string;
  public_key: Buffer;
  private_key(): Buffer;
}

export type OpenedCopy = {
  aad: string;
  credential: z.infer<typeof piCredentialSchema>;
};

const ZERO_BYTE = 0;

export async function openSealedCopy(
  item: SealedHandoverItem,
  shape: SecretShape,
  key: InstanceCopyKey,
): Promise<OpenedCopy | null> {
  const aad = credentialSealAad({
    name: item.name,
    platform: item.platform,
    holder: key.holder,
    sealed_to: key.sealed_to,
  });
  const privateKey = key.private_key();
  try {
    const secret = await openJSON(
      privateKey,
      CREDENTIAL_SEAL_INFO,
      aad,
      item.sealed,
    );
    return { aad, credential: credentialOfSecret(shape, secret) };
  } catch (error) {
    if (error instanceof SealedOpenError) return null;
    throw error;
  } finally {
    privateKey.fill(ZERO_BYTE);
  }
}

export function sealedCopyReporter(
  item: SealedHandoverItem,
  opened: OpenedCopy,
  key: InstanceCopyKey,
  send: (report: WireReport) => Promise<void>,
) {
  let stored: SealedObject = item.sealed;
  let held = normalizeCredential(opened.credential);
  return async (refresh: { credential: Credential }) => {
    const next = normalizeCredential(refresh.credential);
    const sealed =
      digest(next) === digest(held)
        ? stored
        : await sealJSON(
            key.public_key,
            CREDENTIAL_SEAL_INFO,
            opened.aad,
            secretOfCredential(next),
          );
    await send({
      credential_id: item.credential_id,
      digest: digest(stored),
      sealed,
    });
    stored = sealed;
    held = next;
  };
}
