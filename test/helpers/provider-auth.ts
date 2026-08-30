import type {
  CompleteLoginOutcome,
  LoginChallenge,
  ProviderAuth,
  StartLoginInput,
  CompleteLoginInput,
} from "../../src/services/provider-auth/index.ts";

export function createFakeProviderAuth(
  overrides: Partial<ProviderAuth> = {},
): ProviderAuth {
  return {
    async probe() {
      return {
        model: "test-model",
        reachability: "reachable",
        authentication: "accepted",
        completed: true,
        refusal: null,
      };
    },
    oauthVendors() {
      return [];
    },
    async startLogin(_input: StartLoginInput): Promise<LoginChallenge> {
      return {
        method: "manual-code",
        authUrl: "",
        instructions: "",
        expiresAt: null,
      };
    },
    async completeLogin(
      _input: CompleteLoginInput,
    ): Promise<CompleteLoginOutcome> {
      return { status: "lost" };
    },
    abortLogin(_loginId: string) {},
    ...overrides,
  };
}
