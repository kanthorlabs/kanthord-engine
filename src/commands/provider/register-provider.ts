import type { Storage } from "../../services/storage/index.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import {
  llmBaseUrlRefusal,
  parsePayload,
  serializePayload,
  projectPayload,
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
  | "base-url-not-allowed";

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
