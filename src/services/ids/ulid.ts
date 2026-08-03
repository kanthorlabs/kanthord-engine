import { ulid } from "ulid";

import { identityPrefixes } from "../../domain/identity.ts";
import type { IdentityKind } from "../../domain/identity.ts";
import type { IdGenerator } from "./index.ts";

export class UlidIdGenerator implements IdGenerator {
  mint(kind: IdentityKind): string {
    return `${identityPrefixes[kind]}_${ulid()}`;
  }
}
