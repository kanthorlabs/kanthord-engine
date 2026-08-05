import { join } from "node:path";

import type { Crypto } from "../../services/crypto/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import {
  GitError,
  type Git,
  type GitCredential,
  type HostKey,
} from "../../services/git/index.ts";
import {
  deserializePayload,
  type GitPayload,
} from "../../domain/provider-payload.ts";
import type { RepositoryView } from "../../domain/repository.ts";

export type RegisterRepositoryDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
  git: Git;
  readRepositoryView: (id: string) => Promise<RepositoryView | null>;
  homeRoot: string;
}>;

export type RegisterRepositoryInput = Readonly<{
  name: string;
  remoteUrl: string;
  credentialId: string;
  upstreamBranch: string;
  landingBranch: string;
  publishRef: string;
  publishOnApproval: boolean;
  hostFingerprint: string | null;
  actor: string;
}>;

export type RegisterRepositoryRefusal =
  | "name-taken"
  | "credential-not-found"
  | "credential-wrong-kind"
  | "credential-unreadable"
  | "host-fingerprint-required"
  | "host-fingerprint-forbidden"
  | "host-key-mismatch"
  | "host-key-unavailable"
  | "outside-writer";

export type RegisterRepositoryErrorOptions = Readonly<{
  detail?: string;
  presented?: readonly string[];
  confirmed?: string | null;
  expectedOid?: string | null;
  observedOid?: string | null;
}>;

export class RegisterRepositoryError extends Error {
  readonly refusal: RegisterRepositoryRefusal;
  readonly detail: string;
  readonly presented: readonly string[];
  readonly confirmed: string | null;
  readonly expectedOid: string | null;
  readonly observedOid: string | null;

  constructor(
    refusal: RegisterRepositoryRefusal,
    message: string,
    options?: RegisterRepositoryErrorOptions,
  ) {
    super(message);
    this.name = "RegisterRepositoryError";
    this.refusal = refusal;
    this.detail = options?.detail ?? "";
    this.presented = options?.presented ?? [];
    this.confirmed = options?.confirmed ?? null;
    this.expectedOid = options?.expectedOid ?? null;
    this.observedOid = options?.observedOid ?? null;
  }
}

export type RegisterRepositoryResult = RepositoryView;

export const CREDENTIAL_SQL =
  "SELECT kind, payload_ciphertext, payload_iv, payload_tag, key_version FROM provider WHERE id = ?";

type SealedCredentialRow = Readonly<{
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

function unreadable(credentialId: string): RegisterRepositoryError {
  return new RegisterRepositoryError(
    "credential-unreadable",
    `the payload of provider ${credentialId} cannot be decrypted`,
  );
}

function resolveGitCredential(
  dependencies: Readonly<{ storage: Storage; crypto: Crypto }>,
  credentialId: string,
): GitCredential {
  const row = dependencies.storage.transact((transaction) =>
    transaction.get(CREDENTIAL_SQL, [credentialId]),
  );
  if (row === undefined) {
    throw new RegisterRepositoryError(
      "credential-not-found",
      `no provider ${credentialId}`,
    );
  }
  if (!isSealedCredentialRow(row)) {
    throw unreadable(credentialId);
  }
  if (row.kind !== "git") {
    throw new RegisterRepositoryError(
      "credential-wrong-kind",
      `provider ${credentialId} is of kind ${row.kind}; repository.register needs kind git`,
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

export async function registerRepository(
  dependencies: RegisterRepositoryDependencies,
  input: RegisterRepositoryInput,
): Promise<RegisterRepositoryResult> {
  const verdict = dependencies.git.remoteUrlVerdict(input.remoteUrl);
  if (!verdict.allowed) {
    throw new GitError("url-refused", verdict.reason, "");
  }
  const credential = resolveGitCredential(
    { storage: dependencies.storage, crypto: dependencies.crypto },
    input.credentialId,
  );
  if (verdict.transport === "http-basic" && input.hostFingerprint !== null) {
    throw new RegisterRepositoryError(
      "host-fingerprint-forbidden",
      "an http-basic url has no host key",
    );
  }
  let hostKey: HostKey | null = null;
  if (verdict.transport === "ssh") {
    if (input.hostFingerprint === null) {
      throw new RegisterRepositoryError(
        "host-fingerprint-required",
        "an ssh url needs a confirmed hostFingerprint",
      );
    }
    const outcome = await dependencies.git.confirmHostKey({
      remoteUrl: input.remoteUrl,
      hostFingerprint: input.hostFingerprint,
    });
    if (!outcome.confirmed) {
      if (outcome.reason === "fingerprint-mismatch") {
        throw new RegisterRepositoryError(
          "host-key-mismatch",
          `the host presented no key matching ${input.hostFingerprint}`,
          { presented: outcome.presented, confirmed: input.hostFingerprint },
        );
      }
      throw new RegisterRepositoryError(
        "host-key-unavailable",
        `the host key of ${verdict.host} could not be read`,
        { detail: outcome.detail },
      );
    }
    hostKey = outcome.hostKey;
  }
  const nameTaken = dependencies.storage.transact((transaction) =>
    transaction.get("SELECT id FROM repository WHERE name = ?", [input.name]),
  );
  if (nameTaken !== undefined) {
    throw new RegisterRepositoryError(
      "name-taken",
      `a repository named ${input.name} is already registered`,
    );
  }
  const repositoryId = dependencies.ids.mint("repository");
  const homePath = join(dependencies.homeRoot, "repos", `${input.name}.git`);
  const pidFile = join(
    dependencies.homeRoot,
    "git",
    "run",
    `seed-${repositoryId}.pid`,
  );
  let seeded;
  try {
    seeded = await dependencies.git.seedHome({
      gitDir: homePath,
      remoteUrl: input.remoteUrl,
      upstreamBranch: input.upstreamBranch,
      landingBranch: input.landingBranch,
      credential,
      publishRef: input.publishRef,
      hostKey,
      pidFile,
    });
  } catch (error) {
    if (
      error instanceof GitError &&
      (error.failure === "auth-failed" || error.failure === "permission-denied")
    ) {
      dependencies.storage.transact((transaction) =>
        dependencies.events.append(transaction, {
          subjectKind: "provider",
          subjectId: input.credentialId,
          type: "repository.register.credentialRejected",
          actorKind: "human",
          actorId: input.actor,
          payload: {
            failure: error.failure,
            name: input.name,
            publishRef: input.publishRef,
            credentialId: input.credentialId,
          },
        }),
      );
    }
    throw error;
  }
  const landingOid = await dependencies.git.resolveRef({
    gitDir: homePath,
    ref: `refs/heads/${input.landingBranch}`,
  });
  if (landingOid === null) {
    throw new Error("the landing branch was not observed after the seed");
  }
  const now = dependencies.clock.now();
  const gitOperationId = dependencies.ids.mint("gitOperation");
  dependencies.storage.transact((transaction) => {
    const existing = transaction.get(
      "SELECT id FROM repository WHERE name = ?",
      [input.name],
    );
    if (existing !== undefined) {
      throw new RegisterRepositoryError(
        "name-taken",
        `a repository named ${input.name} is already registered`,
      );
    }
    transaction.run(
      "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        repositoryId,
        input.name,
        input.remoteUrl,
        input.credentialId,
        homePath,
        input.upstreamBranch,
        input.landingBranch,
        input.publishRef,
        input.publishOnApproval ? 1 : 0,
        "ready",
        null,
        null,
        seeded.fetchedUpstreamOid,
        now,
      ],
    );
    transaction.run(
      "INSERT INTO git_operation (id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, child_token, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        gitOperationId,
        repositoryId,
        "sync",
        null,
        null,
        null,
        0,
        `refs/heads/${input.landingBranch}`,
        landingOid,
        landingOid,
        landingOid,
        null,
        "complete",
        null,
        null,
        null,
        now,
      ],
    );
    dependencies.events.append(transaction, {
      subjectKind: "repository",
      subjectId: repositoryId,
      type: "repository.registered",
      actorKind: "human",
      actorId: input.actor,
      payload: {
        name: input.name,
        upstreamBranch: input.upstreamBranch,
        landingBranch: input.landingBranch,
        publishRef: input.publishRef,
        publishOnApproval: input.publishOnApproval,
        credentialId: input.credentialId,
        fetchedUpstreamOid: seeded.fetchedUpstreamOid,
        landingOid,
      },
    });
  });
  const view = await dependencies.readRepositoryView(repositoryId);
  if (view === null) {
    throw new Error("the repository row committed without a readable view");
  }
  return view;
}
