import { z } from "zod";
import {
  InboundKind,
  type InboundKindValue,
  InboundPlatform,
  type InboundPlatformValue,
  ResourceKind,
} from "./contract.ts";

export const GITHUB_RESOURCE_PATTERN = /^[^/\s:]+\/[^/\s:]+$/;
const RESOURCE_IDENTITY_SEPARATOR = ":";
const PLATFORM_SEGMENTS = {
  [InboundPlatform.GitHub]: "github",
} as const;

export const githubConfigurationSchema = z.strictObject({
  resource_kind: z.enum(ResourceKind),
  resource: z.string().regex(GITHUB_RESOURCE_PATTERN),
});

export type GitHubConfiguration = z.infer<typeof githubConfigurationSchema>;

const CONFIGURATION_SCHEMAS = {
  [InboundKind.Webhook]: {
    [InboundPlatform.GitHub]: githubConfigurationSchema,
  },
  [InboundKind.Poll]: { [InboundPlatform.GitHub]: githubConfigurationSchema },
} as const;

export function configurationSchemaOf(
  kind: InboundKindValue,
  platform: InboundPlatformValue,
): typeof githubConfigurationSchema {
  return CONFIGURATION_SCHEMAS[kind][platform];
}

export function resourceIdentityOf(
  platform: InboundPlatformValue,
  configuration: GitHubConfiguration,
): string {
  return [
    configuration.resource_kind,
    PLATFORM_SEGMENTS[platform],
    configuration.resource,
  ].join(RESOURCE_IDENTITY_SEPARATOR);
}
