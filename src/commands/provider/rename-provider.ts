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

export type RenameProviderDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  clock: Clock;
  events: EventLog;
}>;

export type RenameProviderInput = Readonly<{
  id: string;
  name: string;
  actor: string;
}>;

export type RenameProviderRefusal = "not-found" | "name-taken";

export class RenameProviderError extends Error {
  readonly refusal: RenameProviderRefusal;

  constructor(refusal: RenameProviderRefusal, message: string) {
    super(message);
    this.name = "RenameProviderError";
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

const columns =
  "id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at";

export function renameProvider(
  dependencies: RenameProviderDependencies,
  input: RenameProviderInput,
): ProviderView {
  const outcome = dependencies.storage.transact((transaction) => {
    const selected = transaction.get(
      `SELECT ${columns} FROM provider WHERE id = ?`,
      [input.id],
    );
    if (selected === undefined) {
      throw new RenameProviderError("not-found", `no provider ${input.id}`);
    }
    const target = selected as ProviderRow;
    const nameTaken = transaction.get(
      "SELECT id FROM provider WHERE name = ? AND id <> ?",
      [input.name, input.id],
    );
    if (nameTaken !== undefined) {
      throw new RenameProviderError(
        "name-taken",
        `a provider named ${input.name} is already registered`,
      );
    }
    if (target.name === input.name) {
      return { row: target, name: target.name, updatedAt: target.updated_at };
    }
    const renamedAt = dependencies.clock.now();
    transaction.run(
      "UPDATE provider SET name = ?, updated_at = ? WHERE id = ?",
      [input.name, renamedAt, input.id],
    );
    dependencies.events.append(transaction, {
      subjectKind: "provider",
      subjectId: input.id,
      type: "provider.renamed",
      actorKind: "human",
      actorId: input.actor,
      payload: { from: target.name, to: input.name },
    });
    return { row: target, name: input.name, updatedAt: renamedAt };
  });
  return projectView(
    dependencies,
    outcome.row,
    outcome.name,
    outcome.updatedAt,
  );
}

function projectView(
  dependencies: RenameProviderDependencies,
  row: ProviderRow,
  name: string,
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
      name,
      kind: row.kind,
      projection: projectPayload(row.kind, parsed),
      setDefaultAt: row.set_default_at,
      updatedAt,
    };
  } catch {
    return {
      id: row.id,
      name,
      kind: row.kind,
      projection: null,
      setDefaultAt: row.set_default_at,
      updatedAt,
    };
  }
}
