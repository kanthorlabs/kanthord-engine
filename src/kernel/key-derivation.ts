import { hkdfSync } from "node:crypto";

const DERIVED_KEY_BYTES = 32;

export function deriveKey(masterKey: string, label: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(masterKey, "base64"),
      Buffer.alloc(0),
      label,
      DERIVED_KEY_BYTES,
    ),
  );
}
