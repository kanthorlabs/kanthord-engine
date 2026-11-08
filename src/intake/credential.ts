import {
  type BindingsNamingFn,
  credentialPlatformList,
  type CredentialPlatformSet,
  type CredentialRecords,
} from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import type { ResourceEntry } from "../kernel/health.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  type IntakeCredentialAnswer,
  intakeCredentialOperations,
} from "./contract.ts";
import { INTAKE_PLATFORMS } from "./credential-platform.ts";

export interface IntakeCredentialDependencies {
  records: CredentialRecords;
  bindingsNaming: BindingsNamingFn;
}

const PLATFORM_SET: CredentialPlatformSet = { platforms: INTAKE_PLATFORMS };

function humanIdentity(caller: CallerContext): string | undefined {
  return caller.identity?.kind === IdentityKind.Human
    ? caller.identity.accountId
    : undefined;
}

export class IntakeCredentials {
  private readonly records: CredentialRecords;
  private readonly bindingsNaming: BindingsNamingFn;

  constructor(dependencies: IntakeCredentialDependencies) {
    this.records = dependencies.records;
    this.bindingsNaming = dependencies.bindingsNaming;
  }

  declare(registry: OperationRegistry): void {
    registry.register(intakeCredentialOperations.platform_list, () =>
      credentialPlatformList(INTAKE_PLATFORMS),
    );
    registry.register(intakeCredentialOperations.create, (input, caller) =>
      caller.commit((tx) =>
        this.records.create(
          tx,
          PLATFORM_SET,
          input.body,
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(intakeCredentialOperations.list, (input, caller) =>
      caller.commit((tx) => this.records.list(tx, PLATFORM_SET, input.query)),
    );
    registry.register(intakeCredentialOperations.get, (input, caller) =>
      caller.commit((tx) => this.get(tx, input.params.credential_name)),
    );
    registry.register(intakeCredentialOperations.rotate, (input, caller) =>
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
      intakeCredentialOperations.update_metadata,
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
    registry.register(intakeCredentialOperations.revoke, (input, caller) =>
      caller.commit((tx) =>
        this.records.revoke(
          tx,
          PLATFORM_SET,
          input.params.credential_name,
          input.params.revision,
        ),
      ),
    );
    registry.register(intakeCredentialOperations.archive, (input, caller) =>
      caller.commit((tx) =>
        this.records.archive(tx, PLATFORM_SET, input.params.credential_name),
      ),
    );
    registry.register(
      intakeCredentialOperations.verify,
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
      intakeCredentialOperations.check,
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

  resourceInventory(tx: Transaction): ResourceEntry[] {
    return this.records.resourceInventory(tx, PLATFORM_SET);
  }

  private get(tx: Transaction, credentialName: string): IntakeCredentialAnswer {
    const answer = this.records.get(tx, PLATFORM_SET, credentialName);
    return {
      ...answer,
      bindings: this.bindingsNaming(tx, credentialName),
    };
  }
}
