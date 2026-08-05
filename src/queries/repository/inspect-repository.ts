import type { Crypto } from "../../services/crypto/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import {
  GitError,
  type Git,
  type GitCredential,
  type GitFailure,
  type HostKey,
} from "../../services/git/index.ts";
import {
  deserializePayload,
  type GitPayload,
} from "../../domain/provider-payload.ts";

export { GitError };

export type InspectRepositoryDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  git: Git;
}>;

export type InspectRepositoryInput = Readonly<{
  remoteUrl: string;
  credentialId: string;
}>;

export type CredentialVerdict =
  | Readonly<{ reachable: true; refusal: null }>
  | Readonly<{ reachable: false; refusal: GitFailure }>;

export type InspectRepositoryResult = Readonly<{
  defaultBranch: string | null;
  branches: readonly string[];
  credential: CredentialVerdict;
  hostKey: HostKey | null;
}>;

export type InspectRefusal =
  | "credential-not-found"
  | "credential-wrong-kind"
  | "credential-unreadable"
  | "host-key-unavailable";

export class InspectRepositoryError extends Error {
  readonly refusal: InspectRefusal;
  readonly detail: string;

  constructor(refusal: InspectRefusal, message: string, detail = "") {
    super(message);
    this.name = "InspectRepositoryError";
    this.refusal = refusal;
    this.detail = detail;
  }
}

export const CREDENTIAL_SQL =
  "SELECT kind, payload_ciphertext, payload_iv, payload_tag, key_version FROM provider WHERE id = ?";

export type SealedCredentialRow = Readonly<{
  kind: string;
  payload_ciphertext: Uint8Array;
  payload_iv: Uint8Array;
  payload_tag: Uint8Array;
  key_version: number;
}>;

function isSealedCredentialRow(value: unknown): value is SealedCredentialRow {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const row = value as Readonly<Record<string, unknown>>;
  return (
    typeof row.kind === "string" &&
    row.payload_ciphertext instanceof Uint8Array &&
    row.payload_iv instanceof Uint8Array &&
    row.payload_tag instanceof Uint8Array &&
    typeof row.key_version === "number"
  );
}

function unreadable(credentialId: string): InspectRepositoryError {
  return new InspectRepositoryError(
    "credential-unreadable",
    `the payload of provider ${credentialId} cannot be decrypted`,
  );
}

export function resolveGitCredential(
  dependencies: Readonly<{ storage: Storage; crypto: Crypto }>,
  credentialId: string,
): GitCredential {
  const row = dependencies.storage.transact((transaction) =>
    transaction.get(CREDENTIAL_SQL, [credentialId]),
  );
  if (row === undefined) {
    throw new InspectRepositoryError(
      "credential-not-found",
      `no provider ${credentialId}`,
    );
  }
  if (!isSealedCredentialRow(row)) {
    throw unreadable(credentialId);
  }
  if (row.kind !== "git") {
    throw new InspectRepositoryError(
      "credential-wrong-kind",
      `provider ${credentialId} is of kind ${row.kind}; repository.inspect needs kind git`,
    );
  }
  let text: string;
  try {
    text = dependencies.crypto.open({
      ciphertext: row.payload_ciphertext,
      iv: row.payload_iv,
      tag: row.payload_tag,
      keyVersion: row.key_version,
    });
  } catch {
    throw unreadable(credentialId);
  }
  try {
    return deserializePayload("git", text) as GitPayload;
  } catch {
    throw unreadable(credentialId);
  }
}

export async function inspectRepository(
  dependencies: InspectRepositoryDependencies,
  input: InspectRepositoryInput,
): Promise<InspectRepositoryResult> {
  const verdict = dependencies.git.remoteUrlVerdict(input.remoteUrl);
  if (!verdict.allowed) {
    throw new GitError("url-refused", verdict.reason, "");
  }
  const credential = resolveGitCredential(
    { storage: dependencies.storage, crypto: dependencies.crypto },
    input.credentialId,
  );
  let hostKey: HostKey | null = null;
  if (verdict.transport === "ssh") {
    const outcome = await dependencies.git.scanHostKeys(input.remoteUrl);
    if (!outcome.scanned) {
      throw new InspectRepositoryError(
        "host-key-unavailable",
        `the host key of ${verdict.host} could not be read`,
        outcome.detail,
      );
    }
    hostKey = outcome.hostKeys[0] ?? null;
  }
  try {
    const info = await dependencies.git.remoteInfo({
      remoteUrl: input.remoteUrl,
      credential,
    });
    return {
      defaultBranch: info.defaultBranch,
      branches: info.branches,
      credential: { reachable: true, refusal: null },
      hostKey,
    };
  } catch (error) {
    if (error instanceof GitError && error.failure !== "url-refused") {
      return {
        defaultBranch: null,
        branches: [],
        credential: { reachable: false, refusal: error.failure },
        hostKey,
      };
    }
    throw error;
  }
}
