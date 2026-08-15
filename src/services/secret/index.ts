export interface Secret {
  generate(): string;
  digest(secret: string): Uint8Array;
  matches(expected: Uint8Array, presented: Uint8Array): boolean;
}
