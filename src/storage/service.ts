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
      caller.commit((tx) => this.get(tx, input.params.credential_name)),
    );
    registry.register(storageOperations.rotate, (input, caller) =>
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
    registry.register(storageOperations.update_metadata, (input, caller) =>
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
    registry.register(storageOperations.revoke, (input, caller) =>
      caller.commit((tx) =>
        this.records.revoke(
          tx,
          PLATFORM_SET,
          input.params.credential_name,
          input.params.revision,
        ),
      ),
    );
    registry.register(storageOperations.archive, (input, caller) =>
      caller.commit((tx) =>
        this.records.archive(tx, PLATFORM_SET, input.params.credential_name),
      ),
    );
    registry.register(storageOperations.verify, async (input, caller) => {
      const answer = await this.records.verify(
        PLATFORM_SET,
        input.params.credential_name,
        caller.context,
      );
      throwIfCancelled(caller.context);
      return caller.commit(() => answer);
    });
    registry.register(storageOperations.check, async (input, caller) => {
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
  ): StorageCredentialAnswer {
    const answer = this.records.get(tx, PLATFORM_SET, credentialName);
    return {
      ...answer,
      bindings: this.bindingsNaming(tx, credentialName).map(
        ({
          project_id: projectId,
          project_name: projectName,
          binding_id: bindingId,
          name,
        }) => ({
          projectId,
          projectName,
          bindingId,
          name,
        }),
      ),
    };
  }
}
