import {
  credentialPlatformList,
  type BindingsNamingFn,
  type CredentialPlatformSet,
  type CredentialRecords,
} from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import type { ResourceEntry } from "../kernel/health.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { storageOperations, type StorageCredentialAnswer } from "./contract.ts";
import { STORAGE_PLATFORMS } from "./platforms.ts";

export interface Dependencies {
  records: CredentialRecords;
  bindingsNaming: BindingsNamingFn;
}

const PLATFORM_SET: CredentialPlatformSet = { platforms: STORAGE_PLATFORMS };

function humanIdentity(caller: CallerContext): string | undefined {
  return caller.identity?.kind === IdentityKind.Human
    ? caller.identity.accountId
    : undefined;
}

export class StorageComponent {
  private readonly records: CredentialRecords;
  private readonly bindingsNaming: BindingsNamingFn;

  constructor(dependencies: Dependencies) {
    this.records = dependencies.records;
    this.bindingsNaming = dependencies.bindingsNaming;
  }

  declare(registry: OperationRegistry): void {
    registry.register(storageOperations.platform_list, () =>
      credentialPlatformList(STORAGE_PLATFORMS),
    );
    registry.register(storageOperations.create, (input, caller) =>
      caller.commit((tx) =>
        this.records.create(
          tx,
          PLATFORM_SET,
          input.body,
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(storageOperations.list, (input, caller) =>
      caller.commit((tx) => this.records.list(tx, PLATFORM_SET, input.query)),
    );
    registry.register(storageOperations.get, (input, caller) =>
      caller.commit((tx) => this.get(tx, input.params.credentialName)),
    );
    registry.register(storageOperations.rotate, (input, caller) =>
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
    registry.register(storageOperations.update_metadata, (input, caller) =>
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
    registry.register(storageOperations.revoke, (input, caller) =>
      caller.commit((tx) =>
        this.records.revoke(
          tx,
          PLATFORM_SET,
          input.params.credentialName,
          input.params.revision,
        ),
      ),
    );
    registry.register(storageOperations.archive, (input, caller) =>
      caller.commit((tx) =>
        this.records.archive(tx, PLATFORM_SET, input.params.credentialName),
      ),
    );
  }

  resourceInventory(tx: Transaction): ResourceEntry[] {
    return this.records.resourceInventory(tx, PLATFORM_SET);
  }

  private get(
    tx: Transaction,
    credentialName: string,
  ): StorageCredentialAnswer {
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
