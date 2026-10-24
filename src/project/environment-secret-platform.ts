import { SecretShape, type CredentialPlatform } from "../custody/contract.ts";

export const ENVIRONMENT_SECRET_PLATFORM = "environment_secret";
export const CAPABILITY_ENVIRONMENT_SECRET = "environment secret";

export const ENVIRONMENT_SECRET_PLATFORMS: Readonly<
  Record<typeof ENVIRONMENT_SECRET_PLATFORM, CredentialPlatform>
> = {
  [ENVIRONMENT_SECRET_PLATFORM]: {
    secret_shape: SecretShape.ApiKey,
    login_modes: [],
    metadata_schema: null,
    capability: CAPABILITY_ENVIRONMENT_SECRET,
    probe: null,
  },
};
