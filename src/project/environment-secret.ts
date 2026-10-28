import {
  type BindingsNamingFn,
  credentialPlatformList,
  type CredentialPlatformSet,
  type CredentialRecords,
} from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  type EnvironmentSecretCredentialAnswer,
  environmentSecretOperations,
} from "./contract.ts";
import { ENVIRONMENT_SECRET_PLATFORMS } from "./environment-secret-platform.ts";

export interface Dependencies {
  records: CredentialRecords;
  bindingsNaming: BindingsNamingFn;
}

const PLATFORM_SET: CredentialPlatformSet = {
  platforms: ENVIRONMENT_SECRET_PLATFORMS,
};

function humanIdentity(caller: CallerContext): string | undefined {
  return caller.identity?.kind === IdentityKind.Human
    ? caller.identity.accountId
    : undefined;
}

export class EnvironmentSecretRoutes {
  private readonly records: CredentialRecords;
  private readonly bindingsNaming: BindingsNamingFn;

  constructor(dependencies: Dependencies) {
    this.records = dependencies.records;
    this.bindingsNaming = dependencies.bindingsNaming;
  }

  declare(registry: OperationRegistry): void {
    registry.register(environmentSecretOperations.platform_list, () =>
      credentialPlatformList(ENVIRONMENT_SECRET_PLATFORMS),
    );
    registry.register(environmentSecretOperations.create, (input, caller) =>
      caller.commit((tx) =>
        this.records.create(
          tx,
          PLATFORM_SET,
          input.body,
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(environmentSecretOperations.list, (input, caller) =>
      caller.commit((tx) => this.records.list(tx, PLATFORM_SET, input.query)),
    );
    registry.register(environmentSecretOperations.get, (input, caller) =>
      caller.commit((tx) => this.get(tx, input.params.credential_name)),
    );
    registry.register(environmentSecretOperations.rotate, (input, caller) =>
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
    registry.register(
      environmentSecretOperations.update_metadata,
      (input, caller) =>
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
    registry.register(environmentSecretOperations.revoke, (input, caller) =>
      caller.commit((tx) =>
        this.records.revoke(
          tx,
          PLATFORM_SET,
          input.params.credential_name,
          input.params.revision,
        ),
      ),
    );
    registry.register(environmentSecretOperations.archive, (input, caller) =>
      caller.commit((tx) =>
        this.records.archive(tx, PLATFORM_SET, input.params.credential_name),
      ),
    );
    registry.register(
      environmentSecretOperations.verify,
      async (input, caller) => {
        const answer = await this.records.verify(
          PLATFORM_SET,
          input.params.credential_name,
          caller.context,
        );
        caller.context.signal.throwIfAborted();
        return caller.commit(() => answer);
      },
    );
    registry.register(
      environmentSecretOperations.check,
      async (input, caller) => {
        const answer = await this.records.check(
          PLATFORM_SET,
          input.body,
          caller.context,
        );
        caller.context.signal.throwIfAborted();
        return caller.commit(() => answer);
      },
    );
  }

  private get(
    tx: Transaction,
    credentialName: string,
  ): EnvironmentSecretCredentialAnswer {
    const answer = this.records.get(tx, PLATFORM_SET, credentialName);
    return {
      ...answer,
      bindings: this.bindingsNaming(tx, credentialName),
    };
  }
}
