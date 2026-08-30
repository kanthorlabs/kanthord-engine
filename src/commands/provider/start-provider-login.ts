import type { Clock } from "../../services/clock/index.ts";
import {
  LoginError,
  type LoginChallenge,
  type OauthVendor,
  type ProviderAuth,
  type StartLoginInput,
} from "../../services/provider-auth/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

export type StartProviderLoginDependencies = Readonly<{
  storage: Storage;
  providerAuth: ProviderAuth;
  ids: IdGenerator;
  clock: Clock;
  instanceId: string;
}>;

export type StartProviderLoginInput = Readonly<{
  provider: string;
  answers: Readonly<Record<string, string>>;
}>;

export type StartProviderLoginRefusal =
  | "provider-not-oauth-capable"
  | "login-in-progress"
  | "login-expired"
  | "login-method-unavailable"
  | "login-input-required"
  | "login-failed";

export class StartProviderLoginError extends Error {
  readonly refusal: StartProviderLoginRefusal;
  readonly detail: string;

  constructor(
    refusal: StartProviderLoginRefusal,
    message: string,
    detail = "",
  ) {
    super(message);
    this.name = "StartProviderLoginError";
    this.refusal = refusal;
    this.detail = detail;
  }
}

export type StartProviderLoginResult = Readonly<{
  loginId: string;
  method: "manual-code" | "device-code";
  expiresAt: number;
  authUrl?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  pollIntervalMs?: number;
}>;

export const MANUAL_LOGIN_LIFETIME_MS = 600_000;

type PendingLogin = Readonly<{
  id: string;
  expires_at: number;
}>;

type PendingCheck =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "in-progress" }>
  | Readonly<{ kind: "expired"; id: string }>;

export function isPendingLoginConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed:\s*provider_login(?:\.provider)?(?:$|[\s,])/.test(
      error.message,
    )
  );
}

export async function startProviderLogin(
  dependencies: StartProviderLoginDependencies,
  input: StartProviderLoginInput,
): Promise<StartProviderLoginResult> {
  const vendor = dependencies.providerAuth
    .oauthVendors()
    .find((candidate: OauthVendor) => candidate.id === input.provider);
  if (vendor === undefined) {
    throw new StartProviderLoginError(
      "provider-not-oauth-capable",
      `${input.provider} has no oauth login`,
    );
  }

  const pending = dependencies.storage.transact<PendingCheck>(
    (transaction: Transaction): PendingCheck => {
      const selected = transaction.get(
        "SELECT id, expires_at FROM provider_login WHERE provider = ? AND state = 'pending'",
        [input.provider],
      ) as PendingLogin | undefined;
      if (selected === undefined) return { kind: "none" };
      if (selected.expires_at > dependencies.clock.now()) {
        return { kind: "in-progress" };
      }
      transaction.run("DELETE FROM provider_login WHERE id = ?", [selected.id]);
      return { kind: "expired", id: selected.id };
    },
  );

  if (pending.kind === "in-progress") {
    throw new StartProviderLoginError(
      "login-in-progress",
      `a login for ${input.provider} is already in progress`,
    );
  }
  if (pending.kind === "expired") {
    dependencies.providerAuth.abortLogin(pending.id);
    throw new StartProviderLoginError(
      "login-expired",
      `the previous login for ${input.provider} expired`,
    );
  }

  const loginId = dependencies.ids.mint("providerLogin");
  const createdAt = dependencies.clock.now();
  let challenge: LoginChallenge;
  try {
    const loginInput: StartLoginInput = {
      loginId,
      vendorId: input.provider,
      answers: input.answers,
    };
    challenge = await dependencies.providerAuth.startLogin(loginInput);
  } catch (error: unknown) {
    if (error instanceof LoginError) {
      throw new StartProviderLoginError(
        error.refusal === "code-required" ? "login-failed" : error.refusal,
        error.message,
        error.detail,
      );
    }
    throw error;
  }

  const expiresAt = challenge.expiresAt ?? createdAt + MANUAL_LOGIN_LIFETIME_MS;
  try {
    dependencies.storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO provider_login (id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?)",
        [
          loginId,
          input.provider,
          challenge.method,
          dependencies.instanceId,
          createdAt,
          expiresAt,
        ],
      );
    });
  } catch (error: unknown) {
    dependencies.providerAuth.abortLogin(loginId);
    if (isPendingLoginConflict(error)) {
      throw new StartProviderLoginError(
        "login-in-progress",
        `a login for ${input.provider} is already in progress`,
      );
    }
    throw error;
  }

  if (challenge.method === "manual-code") {
    return {
      loginId,
      method: challenge.method,
      expiresAt,
      authUrl: challenge.authUrl,
      instructions: challenge.instructions,
    };
  }
  return {
    loginId,
    method: challenge.method,
    expiresAt,
    userCode: challenge.userCode,
    verificationUri: challenge.verificationUri,
    pollIntervalMs: challenge.pollIntervalMs,
  };
}
