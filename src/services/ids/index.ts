import type { IdentityKind } from "../../domain/identity.ts";

export type IdGeneratorErrorCode = "ids-exhausted";

export class IdGeneratorError extends Error {
  readonly code: IdGeneratorErrorCode;

  constructor(code: IdGeneratorErrorCode, message: string) {
    super(message);
    this.name = "IdGeneratorError";
    this.code = code;
  }
}

export interface IdGenerator {
  mint(kind: IdentityKind): string;
}
