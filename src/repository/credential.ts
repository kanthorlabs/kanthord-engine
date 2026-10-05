import {
  credentialPlatformList,
  type BindingsNamingFn,
  type CredentialPlatformSet,
  type CredentialRecords,
} from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { throwIfCancelled } from "../kernel/context.ts";
import type { ResourceEntry } from "../kernel/health.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  repositoryOperations,
  type RepositoryCredentialAnswer,
} from "./contract.ts";
import { REPOSITORY_PLATFORMS } from "./credential-platform.ts";

export interface CredentialDependencies {
  records: CredentialRecords;
  bindingsNaming: BindingsNamingFn;
}

const PLATFORM_SET: CredentialPlatformSet = { platforms: REPOSITORY_PLATFORMS };

function humanIdentity(caller: CallerContext): string | undefined {
  return caller.identity?.kind === IdentityKind.Human
    ? caller.identity.accountId
    : undefined;
}

export class RepositoryCredentials {
  private readonly records: CredentialRecords;
  private readonly bindingsNaming: BindingsNamingFn;

  constructor(dependencies: CredentialDependencies) {
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
      caller.commit((tx) => this.get(tx, input.params.credentialName)),
    );
    registry.register(repositoryOperations.rotate, (input, caller) =>
      caller.commit((tx) =>
        this.records.rotate(
          tx,
          PLATFORM_SET,
          input.params.credentialName,
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
          input.params.credentialName,
          input.body,
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(repositoryOperations.revoke, (input, caller) =>
      caller.commit((tx) =>
        this.records.revoke(
          tx,
          PLATFORM_SET,
          input.params.credentialName,
          input.params.revision,
        ),
      ),
    );
    registry.register(repositoryOperations.archive, (input, caller) =>
      caller.commit((tx) =>
        this.records.archive(tx, PLATFORM_SET, input.params.credentialName),
      ),
    );
    registry.register(repositoryOperations.verify, async (input, caller) => {
      const answer = await this.records.verify(
        PLATFORM_SET,
        input.params.credentialName,
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

  private get(
    tx: Transaction,
    credentialName: string,
  ): RepositoryCredentialAnswer {
    const answer = this.records.get(tx, PLATFORM_SET, credentialName);
    return {
      ...answer,
      bindings: this.bindingsNaming(tx, credentialName).map(
        ({ projectId, projectName, bindingId, name }) => ({
          projectId,
          projectName,
          bindingId,
          name,
        }),
      ),
    };
  }
}
