import type { Storage } from "../../services/storage/index.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import {
  llmBaseUrlRefusal,
  llmOauthRegisterPayload,
  parsePayload,
  serializePayload,
  projectPayload,
  type LlmOauthPayload,
  type LlmOauthRegisterPayload,
  type LlmPayload,
  type ProviderKind,
} from "../../domain/provider-payload.ts";
import type { ModelCatalog } from "../../services/model-catalog/index.ts";
import type { ProviderView } from "../../domain/provider-view.ts";

export type RegisterProviderDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
  catalog: ModelCatalog;
}>;

export type RegisterProviderInput = Readonly<{
  name: string;
  kind: ProviderKind;
  payload: unknown;
  actor: string;
}>;

export type RegisterProviderRefusal =
  | "name-taken"
  | "provider-unknown"
  | "base-url-required"
  | "base-url-not-allowed"
  | "login-not-found"
  | "login-not-completed"
  | "default-model-unknown";

export class RegisterProviderError extends Error {
  readonly refusal: RegisterProviderRefusal;

  constructor(refusal: RegisterProviderRefusal, message: string) {
    super(message);
    this.name = "RegisterProviderError";
    this.refusal = refusal;
  }
}

function assertKnownLlmProvider(
  catalog: ModelCatalog,
  payload: LlmPayload,
): void {
  if (payload.transport === "oauth") {
    return;
  }
  if (!catalog.has(payload.provider)) {
    throw new RegisterProviderError(
      "provider-unknown",
      `${payload.provider} is not a known llm provider`,
    );
  }
  const refusal = llmBaseUrlRefusal(payload.provider, payload.baseUrl);
  if (refusal === "base-url-required") {
    throw new RegisterProviderError(
      refusal,
      `${payload.provider} needs a baseUrl`,
    );
  }
  if (refusal === "base-url-not-allowed") {
    throw new RegisterProviderError(
      refusal,
      `${payload.provider} carries its own baseUrl and takes none`,
    );
  }
}

export function registerProvider(
  dependencies: RegisterProviderDependencies,
  input: RegisterProviderInput,
): ProviderView {
  const oauthRequest =
    input.kind === "llm"
      ? llmOauthRegisterPayload.safeParse(input.payload)
      : undefined;
  if (oauthRequest?.success === true) {
    return registerOauthProvider(dependencies, input, oauthRequest.data);
  }

  const parsed = parsePayload(input.kind, input.payload);
  if (input.kind === "llm") {
    assertKnownLlmProvider(dependencies.catalog, parsed as LlmPayload);
  }
  const text = serializePayload(input.kind, parsed);
  const sealed = dependencies.crypto.seal(text);
  const id = dependencies.ids.mint("provider");
  const updatedAt = dependencies.clock.now();
  let setDefaultAt: number | null = null;
  dependencies.storage.transact((transaction) => {
    const existing = transaction.get("SELECT id FROM provider WHERE name = ?", [
      input.name,
    ]);
    if (existing !== undefined) {
      throw new RegisterProviderError(
        "name-taken",
        `a provider named ${input.name} is already registered`,
      );
    }
    const firstLlm =
      input.kind === "llm" &&
      transaction.get("SELECT id FROM provider WHERE kind = 'llm' LIMIT 1") ===
        undefined;
    if (firstLlm) {
      setDefaultAt = updatedAt;
    }
    transaction.run(
      "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.name,
        input.kind,
        setDefaultAt,
        sealed.ciphertext,
        sealed.iv,
        sealed.tag,
        sealed.keyVersion,
        updatedAt,
      ],
    );
    dependencies.events.append(transaction, {
      subjectKind: "provider",
      subjectId: id,
      type: "provider.registered",
      actorKind: "human",
      actorId: input.actor,
      payload: { name: input.name, kind: input.kind },
    });
    if (setDefaultAt !== null) {
      dependencies.events.append(transaction, {
        subjectKind: "provider",
        subjectId: id,
        type: "provider.defaultSet",
        actorKind: "human",
        actorId: input.actor,
        payload: { name: input.name, kind: input.kind, setDefaultAt },
      });
    }
  });
  return {
    id,
    name: input.name,
    kind: input.kind,
    projection: projectPayload(input.kind, parsed),
    setDefaultAt,
    updatedAt,
  };
}

type ProviderLoginRegistrationRow = Readonly<{
  provider: string;
  state: "pending" | "completed";
  payload_ciphertext: Uint8Array;
  payload_iv: Uint8Array;
  payload_tag: Uint8Array;
  key_version: number;
}>;

type StoredProviderLoginPayload = Readonly<{
  credential: Readonly<Record<string, unknown>>;
  models: readonly string[];
}>;

function registerOauthProvider(
  dependencies: RegisterProviderDependencies,
  input: RegisterProviderInput,
  request: LlmOauthRegisterPayload,
): ProviderView {
  const id = dependencies.ids.mint("provider");
  const updatedAt = dependencies.clock.now();
  const result = dependencies.storage.transact((transaction) => {
    const existing = transaction.get("SELECT id FROM provider WHERE name = ?", [
      input.name,
    ]);
    if (existing !== undefined) {
      throw new RegisterProviderError(
        "name-taken",
        `a provider named ${input.name} is already registered`,
      );
    }

    const selected = transaction.get(
      "SELECT provider, state, payload_ciphertext, payload_iv, payload_tag, key_version FROM provider_login WHERE id = ?",
      [request.loginId],
    ) as ProviderLoginRegistrationRow | undefined;
    if (selected === undefined) {
      throw new RegisterProviderError(
        "login-not-found",
        `no provider login ${request.loginId}`,
      );
    }
    if (selected.state !== "completed") {
      throw new RegisterProviderError(
        "login-not-completed",
        `provider login ${request.loginId} is not completed`,
      );
    }

    const storedLogin = JSON.parse(
      dependencies.crypto.open({
        ciphertext: selected.payload_ciphertext,
        iv: selected.payload_iv,
        tag: selected.payload_tag,
        keyVersion: selected.key_version,
      }),
    ) as StoredProviderLoginPayload;
    if (!storedLogin.models.includes(request.defaultModel)) {
      throw new RegisterProviderError(
        "default-model-unknown",
        `${request.defaultModel} is not available for provider login ${request.loginId}`,
      );
    }
    if (!dependencies.catalog.has(selected.provider)) {
      throw new RegisterProviderError(
        "provider-unknown",
        `${selected.provider} is not a known llm provider`,
      );
    }

    const stored = parsePayload("llm", {
      transport: "oauth",
      provider: selected.provider,
      credential: storedLogin.credential,
      defaultModel: request.defaultModel,
    }) as LlmOauthPayload;
    const sealed = dependencies.crypto.seal(serializePayload("llm", stored));
    const firstLlm =
      transaction.get("SELECT id FROM provider WHERE kind = 'llm' LIMIT 1") ===
      undefined;
    const setDefaultAt = firstLlm ? updatedAt : null;

    transaction.run(
      "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.name,
        input.kind,
        setDefaultAt,
        sealed.ciphertext,
        sealed.iv,
        sealed.tag,
        sealed.keyVersion,
        updatedAt,
      ],
    );
    transaction.run("DELETE FROM provider_login WHERE id = ?", [
      request.loginId,
    ]);
    dependencies.events.append(transaction, {
      subjectKind: "provider",
      subjectId: id,
      type: "provider.registered",
      actorKind: "human",
      actorId: input.actor,
      payload: { name: input.name, kind: input.kind },
    });
    if (setDefaultAt !== null) {
      dependencies.events.append(transaction, {
        subjectKind: "provider",
        subjectId: id,
        type: "provider.defaultSet",
        actorKind: "human",
        actorId: input.actor,
        payload: { name: input.name, kind: input.kind, setDefaultAt },
      });
    }
    return { stored, setDefaultAt };
  });

  return {
    id,
    name: input.name,
    kind: input.kind,
    projection: projectPayload("llm", result.stored),
    setDefaultAt: result.setDefaultAt,
    updatedAt,
  };
}
