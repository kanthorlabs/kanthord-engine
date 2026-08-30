export type VerifyRefusal =
  | "endpoint-unreachable"
  | "credential-rejected"
  | "model-unavailable"
  | "quota-exceeded"
  | "endpoint-rejected";

export type ProbeOutcome = Readonly<{
  model: string;
  reachability: "reachable" | "unreachable";
  authentication: "accepted" | "rejected" | "unknown";
  completed: boolean;
  refusal: VerifyRefusal | null;
  detail?: string;
}>;

export type ProviderAuthRowBase = Readonly<{
  providerId: string;
  vendorId: string;
  defaultModel: string;
  baseUrl: string | null;
}>;

export type ProviderAuthRow = ProviderAuthRowBase &
  (
    | Readonly<{ transport: "api-key"; apiKey: string }>
    | Readonly<{
        transport: "oauth";
        credential: Readonly<Record<string, unknown>>;
      }>
  );

export interface CredentialWriter {
  write(
    providerId: string,
    credential: Readonly<Record<string, unknown>>,
  ): void;
}

export type ProviderAuthRefusal = "vendor-not-catalogued";

export class ProviderAuthError extends Error {
  readonly refusal: ProviderAuthRefusal;

  constructor(refusal: ProviderAuthRefusal, message: string) {
    super(message);
    this.refusal = refusal;
  }
}

export interface ProviderAuth {
  probe(row: ProviderAuthRow, signal: AbortSignal): Promise<ProbeOutcome>;
  oauthVendors(): readonly OauthVendor[];
  startLogin(input: StartLoginInput): Promise<LoginChallenge>;
  completeLogin(input: CompleteLoginInput): Promise<CompleteLoginOutcome>;
  abortLogin(loginId: string): void;
}

export const deviceCodeOptionIds = ["device-code", "device_code"] as const;
export const browserOptionId = "browser";

export type LoginMethod = "manual-code" | "device-code";

export type OauthVendor = Readonly<{
  id: string;
  label: string;
  isSubscription: boolean;
}>;

export type LoginRefusal =
  | "provider-not-oauth-capable"
  | "login-method-unavailable"
  | "login-input-required"
  | "login-in-progress"
  | "code-required"
  | "login-failed";

export class LoginError extends Error {
  readonly refusal: LoginRefusal;
  readonly detail: string;

  constructor(refusal: LoginRefusal, message: string, detail = "") {
    super(message);
    this.name = "LoginError";
    this.refusal = refusal;
    this.detail = detail;
  }
}

export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_EXPIRES_IN_SECONDS = 600;
export const START_TIMEOUT_MS = 30_000;

export type LoginChallenge =
  | Readonly<{
      method: "manual-code";
      authUrl: string;
      instructions: string;
      expiresAt: number | null;
    }>
  | Readonly<{
      method: "device-code";
      userCode: string;
      verificationUri: string;
      pollIntervalMs: number;
      expiresAt: number;
    }>;

export type StartLoginInput = Readonly<{
  loginId: string;
  vendorId: string;
  answers: Readonly<Record<string, string>>;
}>;

export type CompleteLoginInput = Readonly<{
  loginId: string;
  code?: string;
}>;

export type CompletedLogin = Readonly<{
  credential: Readonly<Record<string, unknown>>;
  availableModelIds: readonly string[] | null;
}>;

export type CompleteLoginOutcome =
  | Readonly<{ status: "completed"; login: CompletedLogin }>
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "lost" }>;
