import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  apiKeySecretSchema,
  type CredentialPlatformSet,
  type CredentialRecords,
  type Grant,
  GrantKind,
  type GrantOf,
  type GrantRequest,
  type Material,
} from "../custody/contract.ts";
import type { ServiceIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { ensureDirectory, PRIVATE_FILE_MODE } from "../kernel/files.ts";
import type { Transaction } from "../kernel/store.ts";
import { ENVIRONMENT_SECRET_PLATFORMS } from "./environment-secret-platform.ts";
import type {
  EnvironmentSecretEntry,
  EnvironmentSecretFile,
} from "./environment-state.ts";

export const SecretReleaseOutcome = {
  Released: "released",
  Stale: "stale",
  Unavailable: "unavailable",
} as const;

export type SecretRelease =
  | {
      outcome: typeof SecretReleaseOutcome.Released;
      files: EnvironmentSecretFile[];
      values: string[];
    }
  | { outcome: typeof SecretReleaseOutcome.Stale }
  | { outcome: typeof SecretReleaseOutcome.Unavailable; variable: string };

export interface SecretReleaseInput {
  projectId: string;
  bindingId: string;
  runId: string;
  entries: readonly EnvironmentSecretEntry[];
}

export interface EnvironmentSecretCustody {
  authorizeOperation<R extends GrantRequest>(
    tx: Transaction,
    request: R,
    now: number,
  ): GrantOf<R["kind"]>;
  release(tx: Transaction, grant: Grant, now: number): Material;
}

export interface EnvironmentSecretsDependencies {
  root: string;
  transaction<T>(write: (tx: Transaction) => T): T;
  identity: ServiceIdentity;
  custody: EnvironmentSecretCustody;
  records: Pick<CredentialRecords, "get">;
  now(): number;
}

const NO_LIVE_REVISION = 0;
const RUN_DIRECTORY_PREFIX = "run-";
const SECRETS_DIRECTORY = "secrets";
const PLATFORM_SET: CredentialPlatformSet = {
  platforms: ENVIRONMENT_SECRET_PLATFORMS,
};

export class EnvironmentSecrets {
  private readonly dependencies: EnvironmentSecretsDependencies;

  constructor(dependencies: EnvironmentSecretsDependencies) {
    this.dependencies = dependencies;
  }

  entriesOf(
    variables: Readonly<Record<string, string>>,
  ): EnvironmentSecretEntry[] {
    return this.dependencies.transaction((tx) =>
      Object.entries(variables).map(([variable, credential]) => ({
        variable,
        credential,
        revision: this.newestLiveRevision(tx, credential),
      })),
    );
  }

  release(input: SecretReleaseInput): SecretRelease {
    const released: Array<{ variable: string; material: Material }> = [];
    try {
      const refusal = this.dependencies.transaction((tx) =>
        this.releaseAll(tx, input, released),
      );
      if (refusal !== null) return refusal;
      const values = released.map(
        ({ material }) => apiKeySecretSchema.parse(material.value()).key,
      );
      return {
        outcome: SecretReleaseOutcome.Released,
        files: released.map(({ variable }, index) => ({
          variable,
          file: this.writeSecret(input.runId, variable, values[index]!),
        })),
        values,
      };
    } finally {
      for (const { material } of released) material.drop();
    }
  }

  remove(runId: string): void {
    rmSync(this.directoryOf(runId), { recursive: true, force: true });
  }

  private runDirectoryOf(runId: string): string {
    return join(this.dependencies.root, `${RUN_DIRECTORY_PREFIX}${runId}`);
  }

  private directoryOf(runId: string): string {
    return join(this.runDirectoryOf(runId), SECRETS_DIRECTORY);
  }

  private newestLiveRevision(tx: Transaction, credential: string): number {
    let answer: ReturnType<CredentialRecords["get"]>;
    try {
      answer = this.dependencies.records.get(tx, PLATFORM_SET, credential);
    } catch (error) {
      if (
        error instanceof OperationError &&
        error.status === HttpStatus.NotFound
      )
        return NO_LIVE_REVISION;
      throw error;
    }
    return answer.revisions
      .filter(({ ended_at: endedAt }) => endedAt === null)
      .reduce(
        (newest, { revision }) => Math.max(newest, revision),
        NO_LIVE_REVISION,
      );
  }

  private releaseAll(
    tx: Transaction,
    input: SecretReleaseInput,
    released: Array<{ variable: string; material: Material }>,
  ): SecretRelease | null {
    const { custody, identity } = this.dependencies;
    const now = this.dependencies.now();
    for (const { variable, credential, revision } of input.entries) {
      let material: Material;
      try {
        const grant = custody.authorizeOperation(
          tx,
          {
            kind: GrantKind.EnvironmentSecret,
            identity,
            projectId: input.projectId,
            bindingId: input.bindingId,
            variable,
            credential,
          },
          now,
        );
        material = custody.release(tx, grant, now);
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        return { outcome: SecretReleaseOutcome.Unavailable, variable };
      }
      released.push({ variable, material });
      if (this.revisionOf(tx, credential, material) !== revision)
        return { outcome: SecretReleaseOutcome.Stale };
    }
    return null;
  }

  private revisionOf(
    tx: Transaction,
    credential: string,
    material: Material,
  ): number {
    const answer = this.dependencies.records.get(tx, PLATFORM_SET, credential);
    const found = answer.revisions.find(
      ({ id }) => id === material.credential_id,
    );
    assert.ok(found, "A released material belongs to its credential.");
    return found.revision;
  }

  private writeSecret(runId: string, variable: string, value: string): string {
    const directory = this.directoryOf(runId);
    ensureDirectory(this.dependencies.root);
    ensureDirectory(this.runDirectoryOf(runId));
    ensureDirectory(directory);
    const file = join(directory, variable);
    writeFileSync(file, value, {
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    return file;
  }
}
