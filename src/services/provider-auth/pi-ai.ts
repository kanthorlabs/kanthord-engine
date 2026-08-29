import type {
  CredentialStore,
  Credential,
  CredentialInfo,
  ApiKeyCredential,
} from "@earendil-works/pi-ai";
import {
  builtinModels,
  builtinProviders,
  getBuiltinModels,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

import {
  ProviderAuthError,
  type ProbeOutcome,
  type ProviderAuth,
  type ProviderAuthRow,
} from "./index.ts";
import { toVerdict, type RawOutcome } from "./verdict.ts";

function createStore(row: ProviderAuthRow): CredentialStore {
  return {
    async read(providerId) {
      if (providerId !== row.vendorId) return undefined;
      return { type: "api_key", key: row.apiKey } satisfies ApiKeyCredential;
    },

    async list() {
      return [
        { providerId: row.vendorId, type: "api_key" },
      ] satisfies readonly CredentialInfo[];
    },

    async modify(providerId, fn) {
      if (providerId !== row.vendorId) return undefined;
      const current: Credential | undefined = {
        type: "api_key",
        key: row.apiKey,
      };
      return fn(current);
    },

    async delete(providerId) {
      if (providerId !== row.vendorId) return;
    },
  };
}

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_PROMPT = "What time is it?";
const PROBE_MAX_TOKENS = 16;

type PiAiProviderAuthDependencies = Readonly<{
  createTimeoutSignal: (milliseconds: number) => AbortSignal;
  createModels: typeof builtinModels;
}>;

function toRawOutcome(
  result: AssistantMessage,
  signal: AbortSignal,
): RawOutcome {
  const stop = result.stopReason;
  if (stop === "stop" || stop === "length") {
    return { kind: "success" };
  }
  if (stop === "aborted" || signal.aborted) {
    return { kind: "abort" };
  }
  const match = result.errorMessage?.match(/^(?:\[(\d+)\]|(\d{3}):)/);
  const statusText = match?.[1] ?? match?.[2];
  const httpStatus =
    statusText === undefined ? undefined : parseInt(statusText, 10);
  if (httpStatus === undefined) {
    return { kind: "transport-error" };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { kind: "http-auth", status: httpStatus };
  }
  if (httpStatus === 404) {
    return { kind: "http-not-found", status: httpStatus };
  }
  if (httpStatus === 429) {
    return { kind: "http-quota", status: httpStatus };
  }
  return { kind: "http-other", status: httpStatus };
}

export class PiAiProviderAuth implements ProviderAuth {
  readonly #fetch: typeof fetch;
  readonly #createTimeoutSignal: PiAiProviderAuthDependencies["createTimeoutSignal"];
  readonly #createModels: PiAiProviderAuthDependencies["createModels"];

  constructor(
    fetchImplementation: typeof fetch = fetch,
    dependencies: Partial<PiAiProviderAuthDependencies> = {},
  ) {
    this.#fetch = fetchImplementation;
    this.#createTimeoutSignal =
      dependencies.createTimeoutSignal ??
      ((milliseconds) => AbortSignal.timeout(milliseconds));
    this.#createModels = dependencies.createModels ?? builtinModels;
  }

  async probe(
    row: ProviderAuthRow,
    signal: AbortSignal,
  ): Promise<ProbeOutcome> {
    const provider = builtinProviders().find(
      (entry) => entry.id === row.vendorId,
    );
    if (provider === undefined || provider.auth.apiKey === undefined) {
      throw new ProviderAuthError(
        "vendor-not-catalogued",
        `vendor ${row.vendorId} has no api-key auth in the pi-ai catalog`,
      );
    }

    const builtinModel = getBuiltinModels(row.vendorId as BuiltinProvider).find(
      (model) => model.id === row.defaultModel,
    );
    if (builtinModel === undefined) {
      throw new ProviderAuthError(
        "vendor-not-catalogued",
        `model ${row.defaultModel} is not in the pi-ai catalog for ${row.vendorId}`,
      );
    }

    const probeModel: Model<Api> =
      row.baseUrl !== null
        ? { ...builtinModel, baseUrl: row.baseUrl }
        : builtinModel;
    const timeoutSignal = this.#createTimeoutSignal(PROBE_TIMEOUT_MS);
    const probeSignal = AbortSignal.any([signal, timeoutSignal]);
    const models = this.#createModels({
      credentials: createStore(row),
      authContext: defaultProviderAuthContext(),
    });
    const context: Context = {
      messages: [
        {
          role: "user",
          content: PROBE_PROMPT,
          timestamp: 0,
        },
      ],
    };
    const options: ModelsSimpleStreamOptions = {
      maxTokens: PROBE_MAX_TOKENS,
      signal: probeSignal,
      fetch: this.#fetch,
    };
    const result = await models.completeSimple(probeModel, context, options);
    const raw = toRawOutcome(result, probeSignal);
    return { model: row.defaultModel, ...toVerdict(raw) };
  }
}
