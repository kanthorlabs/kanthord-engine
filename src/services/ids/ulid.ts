import { monotonicFactory } from "ulid";

import { identityPrefixes } from "../../domain/identity.ts";
import type { IdentityKind } from "../../domain/identity.ts";
import type { IdGenerator } from "./index.ts";

const mintUlid = monotonicFactory();

export class UlidIdGenerator implements IdGenerator {
  mint(kind: IdentityKind): string {
    return `${identityPrefixes[kind]}_${mintUlid()}`;
  }
}
