import type {
  CredentialStore,
  Credential,
  CredentialInfo,
  ApiKeyCredential,
} from "@earendil-works/pi-ai";
import {
  builtinModels,
  builtinProviders,
  getBuiltinProviders,
  getBuiltinModels,
  type BuiltinProvider,
} from "@earendil-works/pi-ai/providers/all";
import { defaultProviderAuthContext } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AuthEvent,
  AuthPrompt,
  Context,
  Model,
  ModelsSimpleStreamOptions,
  OAuthAuth,
  OAuthCredential,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";

import {
  DEFAULT_EXPIRES_IN_SECONDS,
  DEFAULT_POLL_INTERVAL_MS,
  START_TIMEOUT_MS,
  browserOptionId,
  deviceCodeOptionIds,
  LoginError,
  ProviderAuthError,
  type CompleteLoginInput,
  type CompleteLoginOutcome,
  type CompletedLogin,
  type CredentialWriter,
  type LoginChallenge,
  type ProbeOutcome,
  type ProviderAuth,
  type ProviderAuthRow,
  type OauthVendor,
  type StartLoginInput,
} from "./index.ts";
import { toVerdict, type RawOutcome } from "./verdict.ts";
import type { Clock } from "../clock/index.ts";

function createStore(
  row: ProviderAuthRow,
  writer: CredentialWriter | undefined,
): CredentialStore {
  const current = (): Credential =>
    row.transport === "oauth"
      ? (row.credential as unknown as OAuthCredential)
      : ({ type: "api_key", key: row.apiKey } satisfies ApiKeyCredential);

  return {
    async read(providerId) {
      if (providerId !== row.vendorId) return undefined;
      return current();
    },

    async list() {
      return [
        { providerId: row.vendorId, type: current().type },
      ] satisfies readonly CredentialInfo[];
    },

    async modify(providerId, fn) {
      if (providerId !== row.vendorId) return undefined;
      const next = await fn(current());
      if (next === undefined) return undefined;
      if (next.type === "oauth" && writer !== undefined) {
        writer.write(
          row.providerId,
          next as unknown as Readonly<Record<string, unknown>>,
        );
      }
      return next;
    },

    async delete(providerId) {
      if (providerId !== row.vendorId) return;
    },
  };
}

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_PROMPT = "What time is it?";
const PROBE_MAX_TOKENS = 16;
const catalogued = new Set<string>(getBuiltinProviders());

type PiAiProviderAuthDependencies = Readonly<{
  createTimeoutSignal: (milliseconds: number) => AbortSignal;
  createModels: typeof builtinModels;
  resolveOauth: (vendorId: string) => OAuthAuth | undefined;
  clock: Clock;
  credentialWriter?: CredentialWriter;
}>;

type LiveLogin = {
  readonly vendorId: string;
  readonly controller: AbortController;
  settled: Promise<OAuthCredential>;
  challenge?: LoginChallenge;
  manualCode?: {
    resolve: (code: string) => void;
    reject: (error: unknown) => void;
  };
  outcome: "running" | "resolved" | "rejected";
  credential?: OAuthCredential;
  failure?: unknown;
};

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

function toLoginError(error: unknown): LoginError {
  if (error instanceof LoginError) return error;
  return new LoginError("login-failed", "the vendor login failed");
}

function readModelIds(credential: OAuthCredential): readonly string[] | null {
  const value: unknown = credential["availableModelIds"];
  if (!Array.isArray(value)) return null;
  if (!value.every((id) => typeof id === "string")) return null;
  return value as readonly string[];
}

function toCompleted(credential: OAuthCredential): CompletedLogin {
  return {
    credential,
    availableModelIds: readModelIds(credential),
  };
}

export function chooseOptionId(
  vendorId: string,
  optionIds: readonly string[],
): string {
  const device = optionIds.find((id) =>
    (deviceCodeOptionIds as readonly string[]).includes(id),
  );
  if (device !== undefined) return device;
  if (optionIds.includes(browserOptionId)) return browserOptionId;
  throw new LoginError(
    "login-method-unavailable",
    `the ${vendorId} login offers no recognized method`,
    optionIds.join(","),
  );
}

export class PiAiProviderAuth implements ProviderAuth {
  readonly #fetch: typeof fetch;
  readonly #createTimeoutSignal: PiAiProviderAuthDependencies["createTimeoutSignal"];
  readonly #createModels: PiAiProviderAuthDependencies["createModels"];
  readonly #resolveOauth: PiAiProviderAuthDependencies["resolveOauth"];
  readonly #clock: Clock;
  readonly #credentialWriter: CredentialWriter | undefined;
  readonly #logins = new Map<string, LiveLogin>();
  readonly #startingVendors = new Set<string>();

  constructor(
    fetchImplementation: typeof fetch = fetch,
    dependencies: Partial<PiAiProviderAuthDependencies> = {},
  ) {
    this.#fetch = fetchImplementation;
    this.#createTimeoutSignal =
      dependencies.createTimeoutSignal ??
      ((milliseconds) => AbortSignal.timeout(milliseconds));
    this.#createModels = dependencies.createModels ?? builtinModels;
    this.#resolveOauth =
      dependencies.resolveOauth ??
      ((vendorId) =>
        builtinProviders().find((provider) => provider.id === vendorId)?.auth
          .oauth);
    this.#clock = dependencies.clock ?? { now: () => Date.now() };
    this.#credentialWriter = dependencies.credentialWriter;
  }

  oauthVendors(): readonly OauthVendor[] {
    return builtinProviders()
      .filter((provider) => provider.auth.oauth !== undefined)
      .filter((provider) => catalogued.has(provider.id))
      .map((provider) => {
        const oauth = provider.auth.oauth as OAuthAuth;
        return {
          id: provider.id,
          label: oauth.loginLabel ?? oauth.name,
          isSubscription: oauth.isSubscription === true,
        };
      })
      .sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.id, "utf8"),
          Buffer.from(right.id, "utf8"),
        ),
      );
  }

  async startLogin(input: StartLoginInput): Promise<LoginChallenge> {
    if (this.#startingVendors.has(input.vendorId)) {
      throw new LoginError(
        "login-in-progress",
        `a ${input.vendorId} login is already starting`,
      );
    }
    this.#startingVendors.add(input.vendorId);

    let live: LiveLogin | undefined;
    try {
      const oauth = this.#resolveOauth(input.vendorId);
      if (oauth === undefined) {
        throw new LoginError(
          "provider-not-oauth-capable",
          `${input.vendorId} has no oauth flow`,
        );
      }

      const controller = new AbortController();
      let resolveChallenge!: () => void;
      let rejectChallenge!: (error: unknown) => void;
      const challengeReady = new Promise<void>((resolve, reject) => {
        resolveChallenge = resolve;
        rejectChallenge = reject;
      });
      let resolveManualCode!: (code: string) => void;
      let rejectManualCode!: (error: unknown) => void;
      const manualCode = new Promise<string>((resolve, reject) => {
        resolveManualCode = resolve;
        rejectManualCode = reject;
      });
      const currentLive: LiveLogin = {
        vendorId: input.vendorId,
        controller,
        settled: undefined as unknown as Promise<OAuthCredential>,
        outcome: "running",
      };
      live = currentLive;

      const interaction: ProviderAuthInteraction = {
        signal: controller.signal,
        prompt: async (prompt: AuthPrompt): Promise<string> => {
          if (prompt.type === "select") {
            return chooseOptionId(
              input.vendorId,
              prompt.options.map((option) => option.id),
            );
          }
          if (prompt.type === "text" || prompt.type === "secret") {
            const answer = input.answers[prompt.message];
            if (answer === undefined) {
              throw new LoginError(
                "login-input-required",
                `the ${input.vendorId} login needs an answer`,
                prompt.message,
              );
            }
            return answer;
          }
          currentLive.manualCode = {
            resolve: resolveManualCode,
            reject: rejectManualCode,
          };
          resolveChallenge();
          return manualCode;
        },
        notify: (event: AuthEvent): void => {
          if (event.type === "auth_url") {
            currentLive.challenge = {
              method: "manual-code",
              authUrl: event.url,
              instructions: event.instructions ?? "",
              expiresAt: null,
            };
            resolveChallenge();
            return;
          }
          if (event.type === "device_code") {
            currentLive.challenge = {
              method: "device-code",
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              pollIntervalMs:
                (event.intervalSeconds ?? DEFAULT_POLL_INTERVAL_MS / 1000) *
                1000,
              expiresAt:
                this.#clock.now() +
                (event.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
            };
            resolveChallenge();
            return;
          }
        },
      };

      const settled = oauth.login(interaction);
      currentLive.settled = settled;
      settled.then(
        (credential) => {
          currentLive.outcome = "resolved";
          currentLive.credential = credential;
        },
        (failure: unknown) => {
          currentLive.outcome = "rejected";
          currentLive.failure = failure;
          rejectChallenge(failure);
        },
      );
      void settled.catch(() => undefined);

      const deadline = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () =>
            reject(new LoginError("login-failed", "the vendor did not answer")),
          START_TIMEOUT_MS,
        );
        timer.unref();
      });
      await Promise.race([challengeReady, deadline]);

      if (currentLive.outcome === "rejected") {
        throw currentLive.failure;
      }
      const challenge = currentLive.challenge;
      if (challenge === undefined) {
        throw new LoginError(
          "login-failed",
          "the vendor returned no challenge",
        );
      }
      this.#logins.set(input.loginId, currentLive);
      return challenge;
    } catch (error: unknown) {
      if (live !== undefined) {
        live.controller.abort();
        this.#forgetLive(input.loginId, live);
      }
      this.#startingVendors.delete(input.vendorId);
      throw toLoginError(error);
    }
  }

  async completeLogin(
    input: CompleteLoginInput,
  ): Promise<CompleteLoginOutcome> {
    const live = this.#logins.get(input.loginId);
    if (live === undefined) return { status: "lost" };

    if (live.outcome === "rejected") {
      this.#forgetLive(input.loginId, live);
      throw toLoginError(live.failure);
    }

    if (live.outcome === "resolved") {
      const credential = live.credential;
      this.#forgetLive(input.loginId, live);
      if (credential === undefined) {
        throw new LoginError(
          "login-failed",
          "the vendor returned no credential",
        );
      }
      return { status: "completed", login: toCompleted(credential) };
    }

    if (live.challenge?.method === "device-code") {
      return { status: "pending" };
    }
    if (input.code === undefined) {
      throw new LoginError("code-required", "the login requires a code");
    }
    if (live.manualCode === undefined) {
      throw new LoginError("login-failed", "the vendor login is not ready");
    }

    live.manualCode.resolve(input.code);
    try {
      const credential = await live.settled;
      this.#forgetLive(input.loginId, live);
      return { status: "completed", login: toCompleted(credential) };
    } catch (error: unknown) {
      this.#forgetLive(input.loginId, live);
      throw toLoginError(error);
    }
  }

  abortLogin(loginId: string): void {
    const live = this.#logins.get(loginId);
    if (live === undefined) return;
    live.controller.abort();
    live.manualCode?.reject(new LoginError("login-failed", "aborted"));
    this.#forgetLive(loginId, live);
  }

  #forgetLive(loginId: string, live: LiveLogin): void {
    if (this.#logins.get(loginId) !== live) return;
    this.#logins.delete(loginId);
    this.#startingVendors.delete(live.vendorId);
  }

  async probe(
    row: ProviderAuthRow,
    signal: AbortSignal,
  ): Promise<ProbeOutcome> {
    const provider = builtinProviders().find(
      (entry) => entry.id === row.vendorId,
    );
    const usable =
      row.transport === "oauth"
        ? provider?.auth.oauth !== undefined
        : provider?.auth.apiKey !== undefined;
    if (provider === undefined || !usable) {
      throw new ProviderAuthError(
        "vendor-not-catalogued",
        row.transport === "oauth"
          ? `vendor ${row.vendorId} has no oauth auth in the pi-ai catalog`
          : `vendor ${row.vendorId} has no api-key auth in the pi-ai catalog`,
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
      credentials: createStore(row, this.#credentialWriter),
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
