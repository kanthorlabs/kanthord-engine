import { z } from "zod";
import {
  apiKeySecretSchema,
  type CredentialPlatform,
  isNonblank,
  SecretShape,
} from "../custody/contract.ts";
import { AUTHORIZATION_HEADER, probeHttp } from "../kernel/probe.ts";
import {
  JIRA_MYSELF_PATH,
  jiraApiUrl,
  jiraBasicAuthorization,
} from "./jira.ts";
import { probeSlackToken } from "./slack.ts";

export const Platform = {
  Jira: "jira",
  Slack: "slack",
  SlackSigningSecret: "slack_signing_secret",
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const CAPABILITY_MYSELF_READ = "myself read";
export const CAPABILITY_AUTH_TEST = "auth test";
export const CAPABILITY_SIGNING_SECRET = "signing secret";

const CLOUD_ID_PATTERN = /^[A-Za-z0-9-]+$/;

export const jiraMetadataSchema = z.strictObject({
  site: z.string().min(1).refine(isNonblank),
  cloud_id: z.string().regex(CLOUD_ID_PATTERN),
  email: z.email(),
});

export const INTAKE_PLATFORMS: Readonly<Record<Platform, CredentialPlatform>> =
  {
    [Platform.Jira]: {
      secret_shape: SecretShape.ApiKey,
      login_modes: [],
      metadata_schema: jiraMetadataSchema,
      capability: CAPABILITY_MYSELF_READ,
      probe: (secret, metadata, context, observe) => {
        const { key } = apiKeySecretSchema.parse(secret);
        const { cloud_id, email } = jiraMetadataSchema.parse(metadata);
        return probeHttp(
          jiraApiUrl(cloud_id, JIRA_MYSELF_PATH),
          { [AUTHORIZATION_HEADER]: jiraBasicAuthorization(email, key) },
          context,
          observe,
        );
      },
    },
    [Platform.Slack]: {
      secret_shape: SecretShape.ApiKey,
      login_modes: [],
      metadata_schema: null,
      capability: CAPABILITY_AUTH_TEST,
      probe: (secret, _metadata, context, observe) =>
        probeSlackToken(apiKeySecretSchema.parse(secret).key, context, observe),
    },
    [Platform.SlackSigningSecret]: {
      secret_shape: SecretShape.ApiKey,
      login_modes: [],
      metadata_schema: null,
      capability: CAPABILITY_SIGNING_SECRET,
      probe: null,
    },
  };
