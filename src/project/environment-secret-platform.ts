import { type CredentialPlatform, SecretShape } from "../custody/contract.ts";
import { ENVIRONMENT_SECRET_PLATFORM } from "./contract.ts";

export { ENVIRONMENT_SECRET_PLATFORM };
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
