import { z } from "zod";
import {
  InboundKind,
  InboundPlatform,
  type InboundKindValue,
  type InboundPlatformValue,
} from "./contract.ts";

export const GITHUB_RESOURCE_PATTERN = /^[^/\s:]+\/[^/\s:]+$/;
const RESOURCE_PREFIXES = {
  [InboundPlatform.GitHub]: "repository:github:",
} as const;

export const githubConfigurationSchema = z.strictObject({
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
  return RESOURCE_PREFIXES[platform] + configuration.resource;
}
