import { Diagnostic } from "../../kernel/errors.ts";
import {
  keyFingerprint,
  type SealedObject,
  sealJSON,
  x25519PublicKeyOf,
} from "../../kernel/hpke.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import { validateClientEndpoint } from "../../gateway/client.ts";
import {
  apiKeySecretSchema,
  CREDENTIAL_SEAL_INFO,
  credentialSealAad,
  SEALED_PLAINTEXT_MAX_BYTES,
} from "../../custody/contract.ts";
import type { InstanceCopyKey } from "../../custody/client.ts";
import type { InstanceConfiguration } from "../../worker/contract.ts";
import { refuseInsecureEndpoint } from "./endpoint-check.ts";
import { InstanceExchange } from "./instance-exchange.ts";

const INSTANCE_KEY_ENCODING = "base64url";
const ZERO_BYTE = 0;
const UTF8 = "utf8";
export const INSTANCE_SECRET_INVALID = "cli.llm.credential.secret_invalid";

export type InstanceSealedCopy = {
  holder: string;
  sealed: SealedObject;
  sealed_to: string;
};

export interface InstanceCredentialAccess {
  endpoint: string;
  token: string;
  seal(
    name: string,
    platform: string,
    secret: unknown,
  ): Promise<InstanceSealedCopy>;
}

export function instanceSecret(secret: unknown): { key: string } {
  const parsed = apiKeySecretSchema.safeParse(secret);
  if (
    !parsed.success ||
    Buffer.byteLength(canonicalJSON(parsed.data), UTF8) >
      SEALED_PLAINTEXT_MAX_BYTES
  )
    throw new Diagnostic(
      INSTANCE_SECRET_INVALID,
      "llm credential: the secret is no API key object within the sealed plaintext limit.",
    );
  return parsed.data;
}

export function instanceCopyKey(
  configuration: InstanceConfiguration,
): InstanceCopyKey {
  const privateKey = () =>
    Buffer.from(configuration.private_key, INSTANCE_KEY_ENCODING);
  const key = privateKey();
  try {
    const publicKey = x25519PublicKeyOf(key);
    return {
      holder: configuration.name,
      sealed_to: keyFingerprint(publicKey),
      public_key: publicKey,
      private_key: privateKey,
    };
  } finally {
    key.fill(ZERO_BYTE);
  }
}

export async function instanceCredentialAccess(
  configuration: InstanceConfiguration,
): Promise<InstanceCredentialAccess> {
  const endpoint = configuration.endpoint;
  validateClientEndpoint(endpoint);
  await refuseInsecureEndpoint(endpoint);
  const { payload } = await new InstanceExchange(
    configuration,
    endpoint,
  ).token();
  const key = instanceCopyKey(configuration);
  return {
    endpoint,
    token: payload.token,
    seal: async (name, platform, secret) => {
      const parsed = instanceSecret(secret);
      return {
        holder: key.holder,
        sealed_to: key.sealed_to,
        sealed: await sealJSON(
          key.public_key,
          CREDENTIAL_SEAL_INFO,
          credentialSealAad({
            name,
            platform,
            holder: key.holder,
            sealed_to: key.sealed_to,
          }),
          parsed,
        ),
      };
    },
  };
}
