import {
  apiKeySecretSchema,
  SecretShape,
  type CredentialPlatform,
} from "../custody/contract.ts";
import type { Context } from "../kernel/context.ts";
import type {
  ResourceObserver,
  ResourceStatusValue,
} from "../kernel/health.ts";
import { AUTHORIZATION_HEADER, probeHttp } from "../kernel/probe.ts";

export const Platform = {
  GitHub: "github",
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const CAPABILITY_RATE_LIMIT_READ = "rate-limit read";
export const GITHUB_RATE_LIMIT_URL = "https://api.github.com/rate_limit";

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
};
