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

export const Platform = {
  Jira: "jira",
} as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const CAPABILITY_MYSELF_READ = "myself read";

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
  };
