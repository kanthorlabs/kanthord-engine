import { LoginError } from "../../services/provider-auth/index.ts";
import type {
  CompleteLoginInput,
  CompleteLoginOutcome,
  ProviderAuth,
} from "../../services/provider-auth/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import type { ModelCatalog } from "../../services/model-catalog/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";

export type CompleteProviderLoginDependencies = Readonly<{
  storage: Storage;
  providerAuth: ProviderAuth;
  crypto: Crypto;
  catalog: ModelCatalog;
  clock: Clock;
  instanceId: string;
}>;

export type CompleteProviderLoginInput = Readonly<{
  loginId: string;
  code?: string;
}>;

export type CompleteProviderLoginRefusal =
  | "not-found"
  | "login-expired"
  | "login-lost"
  | "login-pending"
  | "code-required"
  | "code-not-accepted"
  | "login-failed";

export class CompleteProviderLoginError extends Error {
  readonly refusal: CompleteProviderLoginRefusal;
  readonly detail: string;

  constructor(
    refusal: CompleteProviderLoginRefusal,
    message: string,
    detail = "",
  ) {
    super(message);
    this.name = "CompleteProviderLoginError";
    this.refusal = refusal;
    this.detail = detail;
  }
}

export type CompleteProviderLoginResult = Readonly<{
  loginId: string;
  models: readonly string[];
}>;

type ProviderLoginRow = Readonly<{
  id: string;
  provider: string;
  method: "manual-code" | "device-code";
  state: "pending" | "completed";
  instance_id: string;
  payload_ciphertext: Uint8Array | null;
  payload_iv: Uint8Array | null;
  payload_tag: Uint8Array | null;
  key_version: number | null;
  expires_at: number;
}>;

type StoredLoginPayload = Readonly<{
  credential: Readonly<Record<string, unknown>>;
  models: readonly string[];
}>;

type Preflight =
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "expired"; id: string }>
  | Readonly<{ kind: "replay"; result: CompleteProviderLoginResult }>
  | Readonly<{ kind: "lost"; id: string }>
  | Readonly<{ kind: "code-not-accepted" }>
  | Readonly<{ kind: "pending"; row: ProviderLoginRow }>;

type CompletionWrite =
  | Readonly<{ kind: "not-found" }>
  | Readonly<{
      kind: "completed";
      result: CompleteProviderLoginResult;
    }>;

type LostResolution =
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "completed"; result: CompleteProviderLoginResult }>
  | Readonly<{ kind: "pending" }>;

const loginColumns =
  "id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, expires_at";

export async function completeProviderLogin(
  dependencies: CompleteProviderLoginDependencies,
  input: CompleteProviderLoginInput,
): Promise<CompleteProviderLoginResult> {
  const preflight = dependencies.storage.transact<Preflight>(
    (transaction: Transaction): Preflight => {
      const selected = transaction.get(
        `SELECT ${loginColumns} FROM provider_login WHERE id = ?`,
        [input.loginId],
      );
      if (selected === undefined) return { kind: "not-found" };
      const row = selected as ProviderLoginRow;

      if (row.expires_at <= dependencies.clock.now()) {
        transaction.run("DELETE FROM provider_login WHERE id = ?", [row.id]);
        return { kind: "expired", id: row.id };
      }
      if (row.state === "completed") {
        return {
          kind: "replay",
          result: readStoredResult(dependencies, row),
        };
      }
      if (row.instance_id !== dependencies.instanceId) {
        transaction.run("DELETE FROM provider_login WHERE id = ?", [row.id]);
        return { kind: "lost", id: row.id };
      }
      if (row.method === "device-code" && input.code !== undefined) {
        return { kind: "code-not-accepted" };
      }
      return { kind: "pending", row };
    },
  );

  if (preflight.kind === "not-found") {
    throw new CompleteProviderLoginError(
      "not-found",
      `no provider login ${input.loginId}`,
    );
  }
  if (preflight.kind === "expired") {
    dependencies.providerAuth.abortLogin(preflight.id);
    throw new CompleteProviderLoginError(
      "login-expired",
      `provider login ${input.loginId} expired`,
    );
  }
  if (preflight.kind === "replay") return preflight.result;
  if (preflight.kind === "lost") {
    dependencies.providerAuth.abortLogin(preflight.id);
    throw new CompleteProviderLoginError(
      "login-lost",
      `provider login ${input.loginId} belongs to another instance`,
    );
  }
  if (preflight.kind === "code-not-accepted") {
    throw new CompleteProviderLoginError(
      "code-not-accepted",
      "a device-code login does not accept a code",
    );
  }

  const serviceInput: CompleteLoginInput =
    input.code === undefined
      ? { loginId: input.loginId }
      : { loginId: input.loginId, code: input.code };
  let outcome: CompleteLoginOutcome;
  try {
    outcome = await dependencies.providerAuth.completeLogin(serviceInput);
  } catch (error: unknown) {
    if (error instanceof LoginError) {
      if (error.refusal === "code-required") {
        throw new CompleteProviderLoginError(
          "code-required",
          "the login requires a code",
        );
      }
      throw new CompleteProviderLoginError(
        "login-failed",
        "the provider login failed",
      );
    }
    throw error;
  }

  if (outcome.status === "pending") {
    throw new CompleteProviderLoginError(
      "login-pending",
      "the provider login is still pending",
    );
  }
  if (outcome.status === "lost") {
    const resolution = dependencies.storage.transact<LostResolution>(
      (transaction: Transaction): LostResolution => {
        const selected = transaction.get(
          `SELECT ${loginColumns} FROM provider_login WHERE id = ?`,
          [input.loginId],
        );
        if (selected === undefined) return { kind: "not-found" };
        const row = selected as ProviderLoginRow;
        if (row.state === "completed") {
          return {
            kind: "completed",
            result: readStoredResult(dependencies, row),
          };
        }
        return { kind: "pending" };
      },
    );
    if (resolution.kind === "not-found") {
      throw new CompleteProviderLoginError(
        "not-found",
        `no provider login ${input.loginId}`,
      );
    }
    if (resolution.kind === "completed") return resolution.result;
    throw new CompleteProviderLoginError(
      "login-lost",
      `provider login ${input.loginId} is no longer live`,
    );
  }

  const models =
    outcome.login.availableModelIds ??
    (
      dependencies.catalog
        .providers()
        .find((provider) => provider.id === preflight.row.provider)?.models ??
      []
    ).map((model) => model.id);
  const sealed = dependencies.crypto.seal(
    JSON.stringify({ credential: outcome.login.credential, models }),
  );
  const write = dependencies.storage.transact<CompletionWrite>(
    (transaction: Transaction): CompletionWrite => {
      const current = transaction.get(
        `SELECT ${loginColumns} FROM provider_login WHERE id = ?`,
        [input.loginId],
      );
      if (current === undefined) return { kind: "not-found" };
      const row = current as ProviderLoginRow;
      transaction.run(
        "UPDATE provider_login SET state = 'completed', payload_ciphertext = ?, payload_iv = ?, payload_tag = ?, key_version = ? WHERE id = ? AND state = 'pending'",
        [
          sealed.ciphertext,
          sealed.iv,
          sealed.tag,
          sealed.keyVersion,
          input.loginId,
        ],
      );
      const updated = transaction.get(
        `SELECT ${loginColumns} FROM provider_login WHERE id = ?`,
        [input.loginId],
      );
      if (updated === undefined) return { kind: "not-found" };
      const updatedRow = updated as ProviderLoginRow;
      if (updatedRow.state !== "completed") {
        throw new Error("the provider login did not complete");
      }
      return {
        kind: "completed",
        result:
          row.state === "completed"
            ? readStoredResult(dependencies, updatedRow)
            : { loginId: input.loginId, models },
      };
    },
  );
  if (write.kind === "not-found") {
    throw new CompleteProviderLoginError(
      "not-found",
      `no provider login ${input.loginId}`,
    );
  }
  return write.result;
}

function readStoredResult(
  dependencies: CompleteProviderLoginDependencies,
  row: ProviderLoginRow,
): CompleteProviderLoginResult {
  if (
    row.payload_ciphertext === null ||
    row.payload_iv === null ||
    row.payload_tag === null ||
    row.key_version === null
  ) {
    throw new Error("the completed provider login payload is incomplete");
  }
  const parsed: unknown = JSON.parse(
    dependencies.crypto.open({
      ciphertext: row.payload_ciphertext,
      iv: row.payload_iv,
      tag: row.payload_tag,
      keyVersion: row.key_version,
    }),
  );
  if (!isRecord(parsed)) {
    throw new Error("the completed provider login payload is invalid");
  }
  const credential = parsed.credential;
  const models = parsed.models;
  if (!isRecord(credential) || !Array.isArray(models)) {
    throw new Error("the completed provider login payload is invalid");
  }
  if (!models.every((model) => typeof model === "string")) {
    throw new Error("the completed provider login payload is invalid");
  }
  return {
    loginId: row.id,
    models: models as readonly string[],
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
