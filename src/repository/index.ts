import assert from "node:assert/strict";
import {
  sshKeySecretSchema,
  type GrantFacts,
  type GrantKind,
  type GrantOf,
  type Material,
} from "../custody/contract.ts";
import { background, type Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { HealthStatus, type Healthcheck } from "../kernel/service.ts";
import type { Transaction } from "../kernel/store.ts";
import { checkRepositoryTools, probeRepositoryTools } from "./check.ts";
import {
  gitLsRemote,
  resolveSshHostname,
  resolveSshIdentity,
  clone,
  cloneSnapshot,
  fetchAndCheckout,
  fetchBase,
  pushNodeBranch,
  mergePushFresh,
  pushSnapshotFresh,
  landedOn,
  resolveBranchCommit,
  readFilesAtCommit,
} from "./connector.ts";
import type { SshIdentity, SshPin } from "./ssh-identity.ts";
import { proveSshPin } from "./credential-platform.ts";
import { RepositoryErrorCode } from "./contract.ts";
import { GitHubPlatform } from "./github.ts";
import { knownHostsLine } from "./host-key.ts";
import { isPlatformSshHost } from "./platform.ts";
import type { SshAccess } from "./ssh-agent.ts";
import { sshPublicKeyOf } from "./ssh-key.ts";
import { ProjectErrorCode, RepositoryPlatform } from "../project/contract.ts";
export {
  RepositoryCredentials,
  type CredentialDependencies,
} from "./credential.ts";
export { REPOSITORY_PLATFORMS } from "./credential-platform.ts";
export {
  RepositoryHostKeys,
  type HostKeyDependencies,
  type HostKeySources,
} from "./host-key.ts";
export { repositoryMigrations } from "./migrations.ts";
export { checkServerRepositoryTools } from "./check.ts";
export type { SshAccess } from "./ssh-agent.ts";
export { decodeGitHubEvent } from "./github.ts";
export {
  foldBranchPush,
  GitStage,
  GitWriteError,
  type BranchCommitInput,
  type Landing,
  type MergePushInput,
} from "./connector.ts";

export interface GitWriter {
  mergePushFresh: typeof mergePushFresh;
  pushSnapshotFresh: typeof pushSnapshotFresh;
  landedOn: typeof landedOn;
}

export const platformImplementations = {
  [RepositoryPlatform.GitHub]: GitHubPlatform,
} as const;

export const repositoryFiles = { resolveBranchCommit, readFilesAtCommit };

export type KnownHostsOf = (tx: Transaction, address: string) => string;

export interface Dependencies {
  health?: HealthRegistry;
  checkTools?: () => void;
  knownHostsOf?: KnownHostsOf;
}

const ADDRESS_HOST_PATTERN =
  /^git@([A-Za-z0-9][A-Za-z0-9.-]*):[^/\s:]+\/[^/\s:]+\.git$/;
const LINE_END = "\n";

function addressInvalid(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    ProjectErrorCode.RepositoryAddressInvalid,
    "Repository address must have the form git@<host>:<owner>/<repository>.git with an SSH host of its platform.",
  );
}

export function pinnedKnownHosts(tx: Transaction, address: string): string {
  const host = ADDRESS_HOST_PATTERN.exec(address)?.[1];
  if (host === undefined) throw addressInvalid();
  return `${knownHostsLine(tx, host)}${LINE_END}`;
}

export type SshGrantFacts = GrantFacts<GrantOf<typeof GrantKind.SshIdentity>>;

function legacyKey(credential: string): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    RepositoryErrorCode.SshKeyLegacy,
    "The SSH credential holds no generated key. Use Rotate SSH key.",
    { credential },
  );
}

export class RepositoryComponent implements GitWriter {
  clone = clone;
  cloneSnapshot = cloneSnapshot;
  fetchAndCheckout = fetchAndCheckout;
  fetchBase = fetchBase;
  pushNodeBranch = pushNodeBranch;
  mergePushFresh = mergePushFresh;
  pushSnapshotFresh = pushSnapshotFresh;
  landedOn = landedOn;
  private readonly knownHostsOf: KnownHostsOf;

  constructor(dependencies: Dependencies = {}) {
    (dependencies.checkTools ?? checkRepositoryTools)();
    this.knownHostsOf = dependencies.knownHostsOf ?? pinnedKnownHosts;
    dependencies.health?.register("repository", (context) =>
      this.healthcheck(context),
    );
  }

  sshAccessOf(
    tx: Transaction,
    granted: SshGrantFacts,
    material: Material,
  ): SshAccess {
    try {
      const { credential } = granted;
      assert(credential !== null);
      const known_hosts = this.knownHostsOf(tx, granted.facts.address);
      const secret = sshKeySecretSchema.safeParse(material.value());
      if (!secret.success) throw legacyKey(credential);
      const { private_key } = secret.data;
      let public_key: string;
      try {
        public_key = sshPublicKeyOf(private_key);
      } catch {
        throw legacyKey(credential);
      }
      return { private_key, public_key, known_hosts };
    } finally {
      material.drop();
    }
  }

  static handedSshAccess(private_key: string, known_hosts: string): SshAccess {
    return {
      private_key,
      public_key: sshPublicKeyOf(private_key),
      known_hosts,
    };
  }

  sshHostKeysOf(tx: Transaction, platform: string, address: string): string {
    const host = ADDRESS_HOST_PATTERN.exec(address)?.[1];
    if (host === undefined || !isPlatformSshHost(platform, host))
      throw addressInvalid();
    return this.knownHostsOf(tx, address);
  }

  async healthcheck(context: Context = background): Promise<Healthcheck> {
    const available = await probeRepositoryTools(context);
    return {
      toolchain: available ? HealthStatus.Healthy : HealthStatus.Unavailable,
    };
  }

  resolveSshHostname(
    host: string,
    context: Context,
    deadlineMs: number,
  ): Promise<string> {
    return resolveSshHostname(host, context, deadlineMs);
  }

  proveSshIdentity(
    pin: SshPin,
    context: Context,
    deadlineMs: number,
  ): Promise<void> {
    return proveSshPin(pin, context, deadlineMs);
  }

  resolveSshIdentity(
    host: string,
    context: Context,
    deadlineMs: number,
  ): Promise<SshIdentity> {
    return resolveSshIdentity(host, context, deadlineMs);
  }

  gitLsRemote(
    sshUrl: string,
    context: Context,
    deadlineMs: number,
  ): Promise<void> {
    return gitLsRemote(sshUrl, context, deadlineMs);
  }
}
