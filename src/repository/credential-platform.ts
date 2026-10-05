import {
  apiKeySecretSchema,
  CREDENTIAL_CHECK_TIMEOUT_MS,
  SecretShape,
  type CredentialPlatform,
} from "../custody/contract.ts";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  ResourceStatus,
  type ResourceObserver,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import { AUTHORIZATION_HEADER, probeHttp } from "../kernel/probe.ts";
import { resolveSshIdentity } from "./connector.ts";
import { assertPinned, sshPinSchema, type SshPin } from "./ssh-identity.ts";

export const Platform = {
  GitHub: "github",
  Ssh: "ssh",
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const CAPABILITY_RATE_LIMIT_READ = "rate-limit read";
export const GITHUB_RATE_LIMIT_URL = "https://api.github.com/rate_limit";
export const CAPABILITY_SSH_IDENTITY = "ssh identity";

export async function proveSshPin(
  pin: SshPin,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assertPinned(pin, await resolveSshIdentity(pin.host, context, deadlineMs));
}

async function probeSsh(
  metadata: unknown,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  try {
    await proveSshPin(
      sshPinSchema.parse(metadata),
      context,
      CREDENTIAL_CHECK_TIMEOUT_MS,
    );
    return ResourceStatus.Healthy;
  } catch (error) {
    observe?.(error instanceof OperationError ? error.code : "ssh -G failed");
    return context.err() ? ResourceStatus.Unknown : ResourceStatus.Unhealthy;
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
    secretShape: SecretShape.ApiKey,
    loginModes: [],
    metadataSchema: null,
    capability: CAPABILITY_RATE_LIMIT_READ,
    probe: (secret, _metadata, context, observe) =>
      probeGitHub(apiKeySecretSchema.parse(secret).key, context, observe),
  },
  [Platform.Ssh]: {
    secretShape: SecretShape.None,
    loginModes: [],
    metadataSchema: sshPinSchema,
    capability: CAPABILITY_SSH_IDENTITY,
    probe: (_secret, metadata, context, observe) =>
      probeSsh(metadata, context, observe),
  },
};
