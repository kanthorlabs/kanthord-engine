import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Secret } from "./index.ts";

export class NodeCryptoSecret implements Secret {
  generate(): string {
    return randomBytes(32).toString("base64url");
  }

  digest(secret: string): Uint8Array {
    return createHash("sha256").update(secret, "utf8").digest();
  }

  matches(expected: Uint8Array, presented: Uint8Array): boolean {
    if (expected.length !== presented.length) {
      return false;
    }
    return timingSafeEqual(expected, presented);
  }
}
