export type SealedPayload = Readonly<{
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  keyVersion: number;
}>;

export type CryptoErrorCode =
  "crypto-key-missing" | "crypto-authentication-failed";

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}

export interface Crypto {
  seal(plaintext: string): SealedPayload;
  open(sealed: SealedPayload): string;
}
