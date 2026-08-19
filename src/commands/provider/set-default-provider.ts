import type { Storage } from "../../services/storage/index.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import {
  deserializePayload,
  projectPayload,
  type ProviderKind,
} from "../../domain/provider-payload.ts";
import type { ProviderView } from "../../domain/provider-view.ts";

export type SetDefaultProviderDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  clock: Clock;
  events: EventLog;
}>;

export type SetDefaultProviderInput = Readonly<{
  id: string;
  actor: string;
}>;

export type DisplacedProvider = Readonly<{
  id: string;
  name: string;
}>;

export type ProviderDefaultTransfer = ProviderView &
  Readonly<{ displaced: readonly DisplacedProvider[] }>;

export type SetDefaultProviderRefusal = "not-found" | "kind-not-chainable";

export class SetDefaultProviderError extends Error {
  readonly refusal: SetDefaultProviderRefusal;

  constructor(refusal: SetDefaultProviderRefusal, message: string) {
    super(message);
    this.name = "SetDefaultProviderError";
    this.refusal = refusal;
  }
}

type ProviderRow = Readonly<{
  id: string;
  name: string;
  kind: ProviderKind;
  set_default_at: number | null;
  payload_ciphertext: Uint8Array;
  payload_iv: Uint8Array;
  payload_tag: Uint8Array;
  key_version: number;
  updated_at: number;
}>;

type HolderRow = Readonly<{
  id: string;
  name: string;
}>;

function inIdOrder(holders: readonly HolderRow[]): readonly HolderRow[] {
  return [...holders].sort((left, right) =>
    Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8")),
  );
}

const columns =
  "id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at";

export function setDefaultProvider(
  dependencies: SetDefaultProviderDependencies,
  input: SetDefaultProviderInput,
): ProviderDefaultTransfer {
  const outcome = dependencies.storage.transact((transaction) => {
    const selected = transaction.get(
      `SELECT ${columns} FROM provider WHERE id = ?`,
      [input.id],
    );
    if (selected === undefined) {
      throw new SetDefaultProviderError("not-found", `no provider ${input.id}`);
    }
    const target = selected as ProviderRow;
    if (target.kind === "git") {
      throw new SetDefaultProviderError(
        "kind-not-chainable",
        `provider ${input.id} of kind git cannot join the default chain`,
      );
    }
    if (target.set_default_at !== null) {
      return {
        row: target,
        setDefaultAt: target.set_default_at,
        updatedAt: target.updated_at,
        displaced: [] as readonly DisplacedProvider[],
      };
    }
    const holders = inIdOrder(
      transaction.all(
        "SELECT id, name FROM provider WHERE kind = 'llm' AND set_default_at IS NOT NULL AND id <> ?",
        [input.id],
      ) as readonly HolderRow[],
    );
    const stampedAt = dependencies.clock.now();
    for (const holder of holders) {
      transaction.run(
        "UPDATE provider SET set_default_at = NULL, updated_at = ? WHERE id = ?",
        [stampedAt, holder.id],
      );
      dependencies.events.append(transaction, {
        subjectKind: "provider",
        subjectId: holder.id,
        type: "provider.defaultUnset",
        actorKind: "human",
        actorId: input.actor,
        payload: {
          name: holder.name,
          kind: "llm",
          unsetAt: stampedAt,
        },
      });
    }
    transaction.run(
      "UPDATE provider SET set_default_at = ?, updated_at = ? WHERE id = ?",
      [stampedAt, stampedAt, input.id],
    );
    dependencies.events.append(transaction, {
      subjectKind: "provider",
      subjectId: input.id,
      type: "provider.defaultSet",
      actorKind: "human",
      actorId: input.actor,
      payload: {
        name: target.name,
        kind: target.kind,
        setDefaultAt: stampedAt,
      },
    });
    return {
      row: target,
      setDefaultAt: stampedAt,
      updatedAt: stampedAt,
      displaced: holders.map((holder) => ({
        id: holder.id,
        name: holder.name,
      })),
    };
  });
  return {
    ...projectView(
      dependencies,
      outcome.row,
      outcome.setDefaultAt,
      outcome.updatedAt,
    ),
    displaced: outcome.displaced,
  };
}

function projectView(
  dependencies: SetDefaultProviderDependencies,
  row: ProviderRow,
  setDefaultAt: number | null,
  updatedAt: number,
): ProviderView {
  try {
    const text = dependencies.crypto.open({
      ciphertext: row.payload_ciphertext,
      iv: row.payload_iv,
      tag: row.payload_tag,
      keyVersion: row.key_version,
    });
    const parsed = deserializePayload(row.kind, text);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      projection: projectPayload(row.kind, parsed),
      setDefaultAt,
      updatedAt,
    };
  } catch {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      projection: null,
      setDefaultAt,
      updatedAt,
    };
  }
}
