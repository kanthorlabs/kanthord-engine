import {
  deserializePayload,
  type LlmPayload,
} from "../../domain/provider-payload.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import {
  ProviderAuthError,
  type ProbeOutcome,
  type ProviderAuth,
  type ProviderAuthRow,
} from "../../services/provider-auth/index.ts";
import type { Storage } from "../../services/storage/index.ts";

export type VerifyProviderDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  providerAuth: ProviderAuth;
  clock: Clock;
}>;

export type VerifyProviderInput = Readonly<{
  id: string;
  signal: AbortSignal;
}>;

export type VerifyRefusal =
  "not-found" | "provider-not-verifiable" | "service-unavailable";

export class VerifyProviderError extends Error {
  readonly refusal: VerifyRefusal;

  constructor(refusal: VerifyRefusal, message: string) {
    super(message);
    this.refusal = refusal;
  }
}

export type VerifyProviderResult = Readonly<{
  checkedAt: number;
  model: string;
  reachability: "reachable" | "unreachable";
  authentication: "accepted" | "rejected" | "unknown";
  completed: boolean;
  refusal: string | null;
  detail?: string;
}>;

type ProviderRow = Readonly<{
  id: string;
  kind: string;
  payload_ciphertext: Uint8Array;
  payload_iv: Uint8Array;
  payload_tag: Uint8Array;
  key_version: number;
}>;

const columns = [
  "id",
  "kind",
  "payload_ciphertext",
  "payload_iv",
  "payload_tag",
  "key_version",
] as const;

function readProviderAuthRow(
  dependencies: VerifyProviderDependencies,
  input: VerifyProviderInput,
): ProviderAuthRow {
  return dependencies.storage.transact((transaction) => {
    const row = transaction.get(
      `SELECT ${columns.join(", ")} FROM provider WHERE id = ?`,
      [input.id],
    );
    if (row === undefined) {
      throw new VerifyProviderError("not-found", `no provider ${input.id}`);
    }

    const provider = row as ProviderRow;
    if (provider.kind !== "llm") {
      throw new VerifyProviderError(
        "provider-not-verifiable",
        `provider ${input.id} is kind ${provider.kind}`,
      );
    }

    let text: string;
    try {
      text = dependencies.crypto.open({
        ciphertext: provider.payload_ciphertext,
        iv: provider.payload_iv,
        tag: provider.payload_tag,
        keyVersion: provider.key_version,
      });
    } catch {
      throw new VerifyProviderError(
        "service-unavailable",
        `cannot decrypt provider ${input.id}`,
      );
    }

    try {
      const payload = deserializePayload("llm", text) as LlmPayload;
      if (payload.transport === "oauth") {
        return {
          providerId: provider.id,
          vendorId: payload.provider,
          defaultModel: payload.defaultModel,
          baseUrl: null,
          transport: "oauth",
          credential: payload.credential,
        };
      }
      return {
        providerId: provider.id,
        vendorId: payload.provider,
        transport: "api-key",
        apiKey: payload.apiKey,
        defaultModel: payload.defaultModel,
        baseUrl: payload.baseUrl,
      };
    } catch {
      throw new VerifyProviderError(
        "service-unavailable",
        `cannot parse provider ${input.id} payload`,
      );
    }
  });
}

export async function verifyProvider(
  dependencies: VerifyProviderDependencies,
  input: VerifyProviderInput,
): Promise<VerifyProviderResult> {
  const checkedAt = dependencies.clock.now();
  const authRow = readProviderAuthRow(dependencies, input);

  let outcome: ProbeOutcome;
  try {
    outcome = await dependencies.providerAuth.probe(authRow, input.signal);
  } catch (error) {
    if (
      error instanceof ProviderAuthError &&
      error.refusal === "vendor-not-catalogued"
    ) {
      throw new VerifyProviderError("provider-not-verifiable", error.message);
    }
    throw error;
  }

  return {
    checkedAt,
    model: outcome.model,
    reachability: outcome.reachability,
    authentication: outcome.authentication,
    completed: outcome.completed,
    refusal: outcome.refusal,
    ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
  };
}
