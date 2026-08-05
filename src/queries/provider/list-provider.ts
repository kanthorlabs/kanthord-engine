import type { Storage } from "../../services/storage/index.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import {
  deserializePayload,
  projectPayload,
  type ProviderKind,
  type ProviderProjection,
} from "../../domain/provider-payload.ts";

export type ListProviderDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
}>;

export type ListProviderInput = Readonly<{ kind?: ProviderKind }>;

export type BrokenProviderView = Readonly<{
  id: string;
  name: string;
  kind: ProviderKind;
  projection: null;
  setDefaultAt: number | null;
  updatedAt: number;
}>;

type ProviderView = Readonly<{
  id: string;
  name: string;
  kind: ProviderKind;
  projection: ProviderProjection;
  setDefaultAt: number | null;
  updatedAt: number;
}>;

export type ProviderListItem = ProviderView | BrokenProviderView;

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

function toProviderListItem(
  dependencies: ListProviderDependencies,
  row: ProviderRow,
): ProviderListItem {
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
      setDefaultAt: row.set_default_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      projection: null,
      setDefaultAt: row.set_default_at,
      updatedAt: row.updated_at,
    };
  }
}

export function listProviders(
  dependencies: ListProviderDependencies,
  input: ListProviderInput,
): readonly ProviderListItem[] {
  const filtered = input.kind !== undefined;
  const rows = dependencies.storage.transact((transaction) =>
    filtered
      ? transaction.all(
          `SELECT ${columns} FROM provider WHERE kind = ? ORDER BY id ASC`,
          [input.kind],
        )
      : transaction.all(`SELECT ${columns} FROM provider ORDER BY id ASC`),
  );
  return rows.map((row) =>
    toProviderListItem(dependencies, row as ProviderRow),
  );
}
