import { isNumber } from "../../kernel/values.ts";
const NO_VERSION = 0;
export interface AuthConfig {
  version: number;
  token_lifetime: number;
}
export const authConfigSchema = {
  version: {
    doc: "Authentication version; an increment invalidates every issued JWT and client secret.",
    format(value: unknown) {
      if (
        !isNumber(value) ||
        !Number.isSafeInteger(value) ||
        value <= NO_VERSION
      )
        throw new Error("expected a positive safe integer");
    },
    default: 1,
  },
  token_lifetime: {
    doc: "JWT lifetime in seconds.",
    format: "nat",
    default: 31536000,
  },
};
