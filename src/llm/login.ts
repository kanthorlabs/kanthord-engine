import {
  createModels,
  ModelsError,
  type AuthEvent,
  type AuthPrompt,
  type CredentialStore,
  type Provider,
} from "@earendil-works/pi-ai";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { oauthSecretSchema } from "../custody/contract.ts";
import { LLM_PLATFORMS, Platform } from "./platforms.ts";
import {
  LoginSessionMode,
  LoginSessionState,
  LoginSessionStore,
  type LoginSession,
} from "./sessions.ts";

export const COPILOT_ENTERPRISE_DOMAIN_PLACEHOLDER = "company.ghe.com";
export const OAUTH_PROVIDER_IDS: Partial<Record<Platform, string>> = {
  [Platform.GitHubCopilot]: "github-copilot",
  [Platform.OpenAICodex]: "openai-codex",
};
const PI_LOGIN_MODES = {
  [LoginSessionMode.Browser]: "browser",
  [LoginSessionMode.Device]: "device_code",
} as const;
const PromptType = {
  Select: "select",
  Text: "text",
} as const;
const EventType = {
  Address: "auth_url",
  Device: "device_code",
  Info: "info",
  Progress: "progress",
} as const;
const OAUTH_TYPE = "oauth";
const SINGLE_MODE = 1;
const FIRST_MODE = 0;
const PUBLIC_GITHUB_DOMAIN = "";
const LOGIN_FAILED = "login failed";
const MODE_UNSUPPORTED = "credential.login.mode_unsupported";
const INVALID_INPUT = "credential.input.invalid";
export const LOGIN_NOT_FOUND = "credential.login.not_found";
export const LOGIN_VALUE_NOT_AWAITED = "credential.login.value_not_awaited";
export type OAuthSecret = { refresh: string; access: string; expires: number };

export function loginMode(
  platform: Platform,
  requested?: string,
): LoginSessionMode {
  if (
    requested !== undefined &&
    !Object.values(LoginSessionMode).some((mode) => mode === requested)
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      INVALID_INPUT,
      "Invalid input.",
    );
  const modes = LLM_PLATFORMS[platform].login_modes;
  const selected =
    modes.length === SINGLE_MODE
      ? modes[FIRST_MODE]
      : (requested ?? modes[FIRST_MODE]);
  if (!selected || !modes.includes(selected as LoginSessionMode))
    throw new OperationError(
      HttpStatus.BadRequest,
      MODE_UNSUPPORTED,
      "Unsupported login mode.",
    );
  return selected as LoginSessionMode;
}

export function loginNotFound(): OperationError {
  return new OperationError(
    HttpStatus.NotFound,
    LOGIN_NOT_FOUND,
    "Login session not found.",
  );
}

export class OAuthLogin {
  readonly controller = new AbortController();
  readonly ready = Promise.withResolvers<void>();
  failure: Error = new Error(LOGIN_FAILED);
  private timer?: NodeJS.Timeout;
  private answer?: (value: string) => void;

  private readonly session: LoginSession;
  private readonly sessions: LoginSessionStore;
  private readonly now: () => number;

  constructor(
    session: LoginSession,
    sessions: LoginSessionStore,
    now: () => number,
  ) {
    this.session = session;
    this.sessions = sessions;
    this.now = now;
  }

  requirePending(): void {
    if (this.session.expiresAt <= this.now()) this.expire();
    this.controller.signal.throwIfAborted();
    if (this.session.state !== LoginSessionState.Pending)
      throw new Error(LOGIN_FAILED);
  }

  expire(): void {
    if (this.session.state !== LoginSessionState.Pending) return;
    this.sessions.expire(this.session.id);
    this.failure = loginNotFound();
    this.controller.abort(this.failure);
    this.ready.resolve();
    clearTimeout(this.timer);
  }

  abort(): void {
    if (this.session.state !== LoginSessionState.Pending) return;
    this.sessions.fail(this.session.id, LOGIN_FAILED);
    this.controller.abort(new Error(LOGIN_FAILED));
    this.ready.resolve();
    clearTimeout(this.timer);
  }

  supply(value: string): void {
    if (!this.answer || this.session.state !== LoginSessionState.Pending)
      throw new OperationError(
        HttpStatus.Conflict,
        LOGIN_VALUE_NOT_AWAITED,
        "No login value is awaited.",
      );
    const answer = this.answer;
    this.answer = undefined;
    answer(value);
  }

  private async prompt(prompt: AuthPrompt): Promise<string> {
    this.requirePending();
    if (prompt.type === PromptType.Select) {
      const mode = PI_LOGIN_MODES[this.session.mode as LoginSessionMode];
      if (!prompt.options.some(({ id }) => id === mode))
        throw new Error(LOGIN_FAILED);
      return mode;
    }
    if (
      this.session.platform === Platform.GitHubCopilot &&
      prompt.type === PromptType.Text &&
      prompt.placeholder === COPILOT_ENTERPRISE_DOMAIN_PLACEHOLDER &&
      this.session.address === null
    )
      return PUBLIC_GITHUB_DOMAIN;
    if (this.answer) throw new Error(LOGIN_FAILED);
    const signal = prompt.signal
      ? AbortSignal.any([prompt.signal, this.controller.signal])
      : this.controller.signal;
    signal.throwIfAborted();
    const pending = Promise.withResolvers<string>();
    const abort = () => pending.reject(new Error(LOGIN_FAILED));
    this.answer = pending.resolve;
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await pending.promise;
    } finally {
      signal.removeEventListener("abort", abort);
      if (this.answer === pending.resolve) this.answer = undefined;
    }
  }

  private notify(event: AuthEvent): void {
    this.requirePending();
    if (event.type === EventType.Address) {
      this.sessions.updateAddress(this.session.id, event.url, null);
      this.ready.resolve();
      return;
    }
    if (event.type === EventType.Device) {
      this.sessions.updateAddress(
        this.session.id,
        event.verificationUri,
        event.userCode,
      );
      this.ready.resolve();
      return;
    }
    if (event.type === EventType.Info || event.type === EventType.Progress)
      this.sessions.updateLastMessage(this.session.id, event.message);
  }

  private credentials(persist: (secret: OAuthSecret) => void): CredentialStore {
    return {
      read: async () => undefined,
      list: async () => [],
      delete: async () => {},
      modify: async (providerId, fn, options) => {
        const credential = await fn(undefined);
        if (
          providerId !==
            OAUTH_PROVIDER_IDS[this.session.platform as Platform] ||
          credential?.type !== OAUTH_TYPE
        )
          throw new Error(LOGIN_FAILED);
        const { refresh, access, expires } = credential;
        const parsed = oauthSecretSchema.safeParse({
          refresh,
          access,
          expires,
        });
        if (!parsed.success) throw new Error(LOGIN_FAILED);
        options?.signal?.throwIfAborted();
        this.requirePending();
        if (this.session.address === null) throw new Error(LOGIN_FAILED);
        persist(parsed.data);
        return credential;
      },
    };
  }

  async run(
    providers: () => readonly Provider[],
    persist: (secret: OAuthSecret) => void,
  ): Promise<void> {
    this.timer = setTimeout(
      () => this.expire(),
      this.session.expiresAt - this.now(),
    );
    this.timer.unref();
    try {
      this.requirePending();
      const models = createModels({ credentials: this.credentials(persist) });
      for (const provider of providers()) models.setProvider(provider);
      await models.login(
        OAUTH_PROVIDER_IDS[this.session.platform as Platform]!,
        OAUTH_TYPE,
        {
          signal: this.controller.signal,
          prompt: (prompt) => this.prompt(prompt),
          notify: (event) => this.notify(event),
        },
      );
    } catch (error) {
      const cause = error instanceof ModelsError ? error.cause : error;
      if (this.session.expiresAt <= this.now()) this.expire();
      if (this.session.state === LoginSessionState.Pending) {
        this.failure =
          cause instanceof OperationError ? cause : new Error(LOGIN_FAILED);
        this.sessions.fail(
          this.session.id,
          cause instanceof OperationError ? cause.code : LOGIN_FAILED,
        );
      }
    } finally {
      clearTimeout(this.timer);
      this.controller.abort(new Error(LOGIN_FAILED));
      this.ready.resolve();
    }
  }
}
