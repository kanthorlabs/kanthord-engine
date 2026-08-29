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

export type ProviderAuthRow = Readonly<{
  vendorId: string;
  apiKey: string;
  defaultModel: string;
  baseUrl: string | null;
}>;

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
}
