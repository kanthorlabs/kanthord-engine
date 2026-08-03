import type { IdGenerator } from "../../src/services/ids/index.ts";
import { IdGeneratorError } from "../../src/services/ids/index.ts";
import { identityPrefixes } from "../../src/domain/identity.ts";
import type { IdentityKind } from "../../src/domain/identity.ts";

export type MockIdGeneratorInput = Readonly<{ ulids: readonly string[] }>;

export function createMockIdGenerator(
  input: MockIdGeneratorInput,
): IdGenerator {
  let index = 0;
  return {
    mint(kind: IdentityKind): string {
      if (index >= input.ulids.length) {
        throw new IdGeneratorError(
          "ids-exhausted",
          `mock id generator exhausted after ${input.ulids.length} ids`,
        );
      }
      const ulid = input.ulids[index]!;
      index++;
      return `${identityPrefixes[kind]}_${ulid}`;
    },
  };
}
