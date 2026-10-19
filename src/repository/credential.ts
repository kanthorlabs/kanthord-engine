import {
  credentialPlatformList,
  type BindingsNamingFn,
  type CredentialCheckAnswer,
  type CredentialPlatformSet,
  type CredentialRecords,
  type GeneratedRevision,
} from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { throwIfCancelled, type Context } from "../kernel/context.ts";
import type { ResourceEntry } from "../kernel/health.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  repositoryOperations,
  type RepositoryCredentialAnswer,
} from "./contract.ts";
import { Platform, REPOSITORY_PLATFORMS } from "./credential-platform.ts";
import { generateSshKey } from "./ssh-key.ts";

export interface CredentialDependencies {
  store: Store;
  records: CredentialRecords;
  bindingsNaming: BindingsNamingFn;
}

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

  constructor(dependencies: CredentialDependencies) {
    this.store = dependencies.store;
    this.records = dependencies.records;
    this.bindingsNaming = dependencies.bindingsNaming;
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
