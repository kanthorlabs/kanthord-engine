import { z } from "zod";
import {
  apiKeySecretSchema,
  SecretShape,
  sshKeySecretSchema,
  type CredentialPlatform,
} from "../custody/contract.ts";
import type { Context } from "../kernel/context.ts";
import {
  ResourceFailureReason,
  ResourceStatus,
  type ResourceObserver,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import { AUTHORIZATION_HEADER, probeHttp } from "../kernel/probe.ts";
import { HOST_KEY_FINGERPRINT_PATTERN } from "./contract.ts";
import { sshFingerprintOf, sshPublicKeyOf } from "./ssh-key.ts";

export const Platform = {
  GitHub: "github",
  Ssh: "ssh",
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const CAPABILITY_RATE_LIMIT_READ = "rate-limit read";
export const GITHUB_RATE_LIMIT_URL = "https://api.github.com/rate_limit";
export const CAPABILITY_SSH_IDENTITY = "ssh identity";

export const sshKeyMetadataSchema = z.strictObject({
  public_key: z.string().min(1),
  fingerprint: z.string().regex(HOST_KEY_FINGERPRINT_PATTERN),
});
export type SshKeyMetadata = z.infer<typeof sshKeyMetadataSchema>;

export function probeSshKey(
  secret: unknown,
  metadata: unknown,
  observe?: ResourceObserver,
): ResourceStatusValue {
  try {
    const { private_key } = sshKeySecretSchema.parse(secret);
    const stored = sshKeyMetadataSchema.parse(metadata);
    const derived = sshPublicKeyOf(private_key);
    if (
      derived !== stored.public_key ||
      sshFingerprintOf(derived) !== stored.fingerprint
    )
      throw new Error("The SSH key differs from the stored public key.");
    return ResourceStatus.Healthy;
  } catch {
    observe?.(
      "the SSH key does not load",
      ResourceFailureReason.IdentityUnavailable,
    );
    return ResourceStatus.Unhealthy;
  }
}

export async function probeGitHub(
  apiKey: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  return probeHttp(
    GITHUB_RATE_LIMIT_URL,
    { [AUTHORIZATION_HEADER]: `Bearer ${apiKey}` },
    context,
    observe,
  );
}

export const REPOSITORY_PLATFORMS: Readonly<
  Record<Platform, CredentialPlatform>
> = {
  [Platform.GitHub]: {
    secret_shape: SecretShape.ApiKey,
    login_modes: [],
    metadata_schema: null,
    capability: CAPABILITY_RATE_LIMIT_READ,
    probe: (secret, _metadata, context, observe) =>
      probeGitHub(apiKeySecretSchema.parse(secret).key, context, observe),
  },
  [Platform.Ssh]: {
    secret_shape: SecretShape.SshKey,
    login_modes: [],
    metadata_schema: sshKeyMetadataSchema,
    capability: CAPABILITY_SSH_IDENTITY,
    probe: async (secret, metadata, _context, observe) =>
      probeSshKey(secret, metadata, observe),
  },
};
