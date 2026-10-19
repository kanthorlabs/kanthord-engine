import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  credentialPlatformList,
  CREDENTIAL_CHECK_TIMEOUT_MS,
  type BindingsNamingFn,
  type CredentialCheckAnswer,
  type CredentialPlatformSet,
  type CredentialRecords,
  type GeneratedRevision,
} from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { throwIfCancelled, type Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import type { ResourceEntry } from "../kernel/health.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { resolveSshIdentity } from "./connector.ts";
import {
  repositoryOperations,
  SshDiscoverState,
  SSH_CONFIG_UNREADABLE_STATUS,
  type RepositoryCredentialAnswer,
  type SshDiscoverAnswer,
} from "./contract.ts";
import { Platform, REPOSITORY_PLATFORMS } from "./credential-platform.ts";
import { generateSshKey } from "./ssh-key.ts";
import {
  ambiguityOf,
  configHosts,
  SshErrorCode,
  sshPinSchema,
  type SshIdentity,
} from "./ssh-identity.ts";

export type ResolveSshIdentityFn = (
  host: string,
  context: Context,
  deadlineMs: number,
) => Promise<SshIdentity>;

export interface CredentialDependencies {
  store: Store;
  records: CredentialRecords;
  bindingsNaming: BindingsNamingFn;
  sshConfigPath?: string;
  resolveSshIdentity?: ResolveSshIdentityFn;
}

export const DiscoverKeyword = {
  GitHub: "github",
  GitLab: "gitlab",
  Bitbucket: "bitbucket",
} as const;

const SSH_CONFIG_PATH = join(homedir(), ".ssh", "config");
const UTF8_ENCODING = "utf8";

const PLATFORM_SET: CredentialPlatformSet = { platforms: REPOSITORY_PLATFORMS };

export function sshKeyRevision(name: string): GeneratedRevision {
  const { private_key, public_key, fingerprint } = generateSshKey(name);
  return { secret: { private_key }, metadata: { public_key, fingerprint } };
}

function humanIdentity(caller: CallerContext): string | undefined {
  return caller.identity?.kind === IdentityKind.Human
    ? caller.identity.accountId
    : undefined;
}

export class RepositoryCredentials {
  private readonly store: Store;
  private readonly records: CredentialRecords;
  private readonly bindingsNaming: BindingsNamingFn;
  private readonly sshConfigPath: string;
  private readonly resolveSshIdentity: ResolveSshIdentityFn;

  constructor(dependencies: CredentialDependencies) {
    this.store = dependencies.store;
    this.records = dependencies.records;
    this.bindingsNaming = dependencies.bindingsNaming;
    this.sshConfigPath = dependencies.sshConfigPath ?? SSH_CONFIG_PATH;
    this.resolveSshIdentity =
      dependencies.resolveSshIdentity ?? resolveSshIdentity;
  }

  declare(registry: OperationRegistry): void {
    registry.register(repositoryOperations.platform_list, () =>
      credentialPlatformList(REPOSITORY_PLATFORMS),
    );
    registry.register(repositoryOperations.create, (input, caller) =>
      caller.commit((tx) =>
        this.records.create(
          tx,
          PLATFORM_SET,
          input.body,
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(repositoryOperations.list, (input, caller) =>
      caller.commit((tx) => this.records.list(tx, PLATFORM_SET, input.query)),
    );
    registry.register(repositoryOperations.get, (input, caller) =>
      caller.commit((tx) => this.get(tx, input.params.credential_name)),
    );
    registry.register(repositoryOperations.rotate, (input, caller) =>
      caller.commit((tx) =>
        this.records.rotate(
          tx,
          PLATFORM_SET,
          input.params.credential_name,
          input.body,
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(repositoryOperations.update_metadata, (input, caller) =>
      caller.commit((tx) =>
        this.records.updateMetadata(
          tx,
          PLATFORM_SET,
          input.params.credential_name,
          input.body,
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(repositoryOperations.ssh_key_create, (input, caller) =>
      caller.commit((tx) =>
        this.records.createGenerated(
          tx,
          PLATFORM_SET,
          {
            name: input.body.name,
            platform: Platform.Ssh,
            generate: sshKeyRevision,
          },
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(repositoryOperations.ssh_key_rotate, (input, caller) =>
      caller.commit((tx) =>
        this.records.rotateGenerated(
          tx,
          PLATFORM_SET,
          input.params.credential_name,
          {
            expected_revision: input.body.expected_revision,
            generate: sshKeyRevision,
          },
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(repositoryOperations.ssh_discover, (_input, caller) =>
      this.discover(caller),
    );
    registry.register(repositoryOperations.revoke, (input, caller) =>
      caller.commit((tx) =>
        this.records.revoke(
          tx,
          PLATFORM_SET,
          input.params.credential_name,
          input.params.revision,
        ),
      ),
    );
    registry.register(repositoryOperations.archive, (input, caller) =>
      caller.commit((tx) =>
        this.records.archive(tx, PLATFORM_SET, input.params.credential_name),
      ),
    );
    registry.register(repositoryOperations.verify, async (input, caller) => {
      const answer = await this.records.verify(
        PLATFORM_SET,
        input.params.credential_name,
        caller.context,
      );
      throwIfCancelled(caller.context);
      return caller.commit(() => answer);
    });
    registry.register(repositoryOperations.check, async (input, caller) => {
      const answer = await this.records.check(
        PLATFORM_SET,
        input.body,
        caller.context,
      );
      throwIfCancelled(caller.context);
      return caller.commit(() => answer);
    });
  }

  resourceInventory(tx: Transaction): ResourceEntry[] {
    return this.records.resourceInventory(tx, PLATFORM_SET);
  }

  verifyCredential(
    credentialName: string,
    context: Context,
  ): Promise<CredentialCheckAnswer> {
    return this.records.verify(PLATFORM_SET, credentialName, context);
  }

  private async discover(caller: CallerContext): Promise<SshDiscoverAnswer> {
    let text: string;
    try {
      text = await readFile(this.sshConfigPath, UTF8_ENCODING);
    } catch {
      throw new OperationError(
        SSH_CONFIG_UNREADABLE_STATUS,
        SshErrorCode.ConfigUnreadable,
        "The SSH configuration is unreadable.",
      );
    }
    const resolved = await Promise.all(
      configHosts(text).map(async (host) => {
        try {
          const identity = await this.resolveSshIdentity(
            host,
            caller.context,
            CREDENTIAL_CHECK_TIMEOUT_MS,
          );
          return { host, identity };
        } catch {
          return null;
        }
      }),
    );
    throwIfCancelled(caller.context);
    const keywords = Object.values(DiscoverKeyword);
    return caller.commit((tx) => {
      const present = this.pinnedHosts(tx);
      const items = resolved
        .filter((entry) => entry !== null)
        .filter(({ identity }) =>
          keywords.some((keyword) =>
            identity.hostname.toLowerCase().includes(keyword),
          ),
        )
        .map(({ host, identity }) => {
          const ambiguous = ambiguityOf(identity);
          const state = present.has(host)
            ? SshDiscoverState.Present
            : ambiguous === null
              ? SshDiscoverState.Ready
              : SshDiscoverState.Refused;
          return {
            host,
            hostname: identity.hostname,
            port: identity.port,
            identity_file:
              ambiguous === null ? identity.identityFiles[0]! : null,
            state,
            reason:
              state === SshDiscoverState.Refused
                ? SshErrorCode.IdentityAmbiguous
                : null,
          };
        });
      return { items };
    });
  }

  private pinnedHosts(tx: Transaction): Set<string> {
    const hosts = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = this.records.list(tx, PLATFORM_SET, {
        platform: Platform.Ssh,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const item of page.items) {
        const live = item.revisions.find(({ ended_at }) => ended_at === null);
        const pin = sshPinSchema.safeParse(live?.metadata);
        if (pin.success) hosts.add(pin.data.host);
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return hosts;
  }

  private get(
    tx: Transaction,
    credentialName: string,
  ): RepositoryCredentialAnswer {
    const answer = this.records.get(tx, PLATFORM_SET, credentialName);
    return {
      ...answer,
      bindings: this.bindingsNaming(tx, credentialName),
    };
  }
}
