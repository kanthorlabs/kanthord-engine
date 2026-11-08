import assert from "node:assert/strict";
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
export const JIRA_RESOURCE_PATTERN =
  /^[a-z0-9][a-z0-9-]*\.atlassian\.net\/[A-Z][A-Z0-9_]{1,9}$/;
const PLATFORM_SEGMENTS = {
  [InboundPlatform.GitHub]: "github",
  [InboundPlatform.Jira]: "jira",
} as const;

export const githubConfigurationSchema = z.strictObject({
  resource_kind: z.enum(ResourceKind),
  resource: z.string().regex(GITHUB_RESOURCE_PATTERN),
});

export type GitHubConfiguration = z.infer<typeof githubConfigurationSchema>;

export const jiraConfigurationSchema = z.strictObject({
  resource_kind: z.literal(ResourceKind.Conversation),
  resource: z.string().regex(JIRA_RESOURCE_PATTERN),
});

const CONFIGURATION_SCHEMAS: Readonly<
  Record<
    InboundKindValue,
    Partial<Record<InboundPlatformValue, z.ZodType<GitHubConfiguration>>>
  >
> = {
  [InboundKind.Webhook]: {
    [InboundPlatform.GitHub]: githubConfigurationSchema,
    [InboundPlatform.Jira]: jiraConfigurationSchema,
  },
  [InboundKind.Poll]: { [InboundPlatform.GitHub]: githubConfigurationSchema },
};

export function inboundSupported(
  kind: InboundKindValue,
  platform: InboundPlatformValue,
): boolean {
  return CONFIGURATION_SCHEMAS[kind][platform] !== undefined;
}

export function configurationSchemaOf(
  kind: InboundKindValue,
  platform: InboundPlatformValue,
): z.ZodType<GitHubConfiguration> {
  const schema = CONFIGURATION_SCHEMAS[kind][platform];
  assert.ok(schema, "The platform supports the inbound kind.");
  return schema;
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
