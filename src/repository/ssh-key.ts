import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

export interface SshKey {
  private_key: string;
  public_key: string;
  fingerprint: string;
}

const KEY_TYPE = "ssh-ed25519";
const KEY_MAGIC = "openssh-key-v1\0";
const NO_CIPHER = "none";
const NO_KDF = "none";
const NO_KDF_OPTIONS = "";
const KEY_COUNT = 1;
const COMMENT_PREFIX = "kanthord-";
const ARMOR_BEGIN = "-----BEGIN OPENSSH PRIVATE KEY-----";
const ARMOR_END = "-----END OPENSSH PRIVATE KEY-----";
const ARMOR_LINE_LENGTH = 70;
const LINE_END = "\n";
const FIELD_SEPARATOR = " ";
const FINGERPRINT_PREFIX = "SHA256:";
const BASE64_PADDING = /=+$/;
const BASE64_TEXT = /^[A-Za-z0-9+/]+={0,2}$/;
const PRIVATE_KEY_BYTES_MAX = 4096;
const PUBLIC_KEY_BYTES = 32;
const SEED_BYTES = 32;
const SECRET_KEY_BYTES = SEED_BYTES + PUBLIC_KEY_BYTES;
const PKCS8_SEED_OFFSET = 16;
const SPKI_PUBLIC_KEY_OFFSET = 12;
const CHECK_BYTES = 4;
const LENGTH_BYTES = 4;
const BLOCK_BYTES = 8;
const FIRST_PADDING_BYTE = 1;
const ALIGNED = 0;
const PUBLIC_KEY_FIELDS_MIN = 2;

class SshWriter {
  private readonly parts: Buffer[] = [];

  bytes(value: Buffer): this {
    const length = Buffer.alloc(LENGTH_BYTES);
    length.writeUInt32BE(value.length);
    this.parts.push(length, value);
    return this;
  }

  text(value: string): this {
    return this.bytes(Buffer.from(value, "utf8"));
  }

  uint32(value: number): this {
    const bytes = Buffer.alloc(LENGTH_BYTES);
    bytes.writeUInt32BE(value);
    this.parts.push(bytes);
    return this;
  }

  raw(value: Buffer): this {
    this.parts.push(value);
    return this;
  }

  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

class SshReader {
  private offset = 0;
  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  uint32(): number {
    if (this.offset + LENGTH_BYTES > this.buffer.length)
      throw new Error("The SSH key ends early.");
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += LENGTH_BYTES;
    return value;
  }

  bytes(): Buffer {
    const length = this.uint32();
    if (this.offset + length > this.buffer.length)
      throw new Error("The SSH key ends early.");
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  text(): string {
    return this.bytes().toString("utf8");
  }

  magic(value: string): boolean {
    const end = this.offset + value.length;
    if (end > this.buffer.length) return false;
    const matches =
      this.buffer.subarray(this.offset, end).toString("latin1") === value;
    this.offset = end;
    return matches;
  }

  rest(): Buffer {
    const value = this.buffer.subarray(this.offset);
    this.offset = this.buffer.length;
    return value;
  }
}

function publicBlob(publicKey: Buffer): Buffer {
  return new SshWriter().text(KEY_TYPE).bytes(publicKey).build();
}

function publicKeyLine(publicKey: Buffer, comment: string): string {
  const blob = publicBlob(publicKey).toString("base64");
  return [KEY_TYPE, blob, comment].join(FIELD_SEPARATOR);
}

function armor(body: Buffer): string {
  const text = body.toString("base64");
  const lines = [ARMOR_BEGIN];
  for (let index = 0; index < text.length; index += ARMOR_LINE_LENGTH)
    lines.push(text.slice(index, index + ARMOR_LINE_LENGTH));
  lines.push(ARMOR_END);
  return lines.join(LINE_END) + LINE_END;
}

function privateSection(
  seed: Buffer,
  publicKey: Buffer,
  comment: string,
): Buffer {
  const check = randomBytes(CHECK_BYTES);
  const secret = Buffer.concat([seed, publicKey]);
  const writer = new SshWriter()
    .raw(check)
    .raw(Buffer.from(check))
    .text(KEY_TYPE)
    .bytes(publicKey)
    .bytes(secret)
    .text(comment);
  const unpadded = writer.build();
  const padding = Buffer.alloc(
    (BLOCK_BYTES - (unpadded.length % BLOCK_BYTES)) % BLOCK_BYTES,
  );
  for (let index = 0; index < padding.length; index += 1)
    padding[index] = FIRST_PADDING_BYTE + index;
  const section = Buffer.concat([unpadded, padding]);
  unpadded.fill(0);
  secret.fill(0);
  return section;
}

function openSshPrivateKey(
  seed: Buffer,
  publicKey: Buffer,
  comment: string,
): string {
  const section = privateSection(seed, publicKey, comment);
  const writer = new SshWriter()
    .raw(Buffer.from(KEY_MAGIC, "latin1"))
    .text(NO_CIPHER)
    .text(NO_KDF)
    .text(NO_KDF_OPTIONS)
    .uint32(KEY_COUNT)
    .bytes(publicBlob(publicKey))
    .bytes(section);
  const body = writer.build();
  try {
    return armor(body);
  } finally {
    body.fill(0);
    section.fill(0);
  }
}

export function generateSshKey(name: string): SshKey {
  assert.ok(name);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  try {
    const seed = pkcs8.subarray(PKCS8_SEED_OFFSET);
    const publicBytes = spki.subarray(SPKI_PUBLIC_KEY_OFFSET);
    assert.equal(seed.length, SEED_BYTES);
    assert.equal(publicBytes.length, PUBLIC_KEY_BYTES);
    const comment = `${COMMENT_PREFIX}${name}`;
    const public_key = publicKeyLine(publicBytes, comment);
    return {
      private_key: openSshPrivateKey(seed, publicBytes, comment),
      public_key,
      fingerprint: sshFingerprintOf(public_key),
    };
  } finally {
    pkcs8.fill(0);
    spki.fill(0);
  }
}

function armorBody(text: string): Buffer {
  if (Buffer.byteLength(text, "utf8") > PRIVATE_KEY_BYTES_MAX)
    throw new Error("The SSH key is too large.");
  const lines = text.trim().split(LINE_END);
  if (lines[0]?.trim() !== ARMOR_BEGIN || lines.at(-1)?.trim() !== ARMOR_END)
    throw new Error("The SSH key is not an openssh-key-v1 text.");
  const body = lines.slice(1, -1).join("").replace(/\s/g, "");
  if (!BASE64_TEXT.test(body))
    throw new Error("The SSH key is not an openssh-key-v1 text.");
  return Buffer.from(body, "base64");
}

function readPublicBlob(blob: Buffer): Buffer {
  const reader = new SshReader(blob);
  if (reader.text() !== KEY_TYPE)
    throw new Error("The SSH key is not ed25519.");
  const publicKey = reader.bytes();
  if (publicKey.length !== PUBLIC_KEY_BYTES || reader.rest().length)
    throw new Error("The SSH public key is malformed.");
  return publicKey;
}

function readPrivateSection(section: Buffer, publicKey: Buffer): string {
  if (section.length % BLOCK_BYTES !== ALIGNED)
    throw new Error("The SSH private section is malformed.");
  const reader = new SshReader(section);
  if (reader.uint32() !== reader.uint32())
    throw new Error("The SSH check integers differ.");
  if (reader.text() !== KEY_TYPE)
    throw new Error("The SSH key is not ed25519.");
  const sectionPublicKey = reader.bytes();
  const secret = reader.bytes();
  if (
    !sectionPublicKey.equals(publicKey) ||
    secret.length !== SECRET_KEY_BYTES ||
    !secret.subarray(SEED_BYTES).equals(publicKey)
  )
    throw new Error("The SSH key pair is inconsistent.");
  const comment = reader.text();
  const padding = reader.rest();
  for (let index = 0; index < padding.length; index += 1)
    if (padding[index] !== FIRST_PADDING_BYTE + index)
      throw new Error("The SSH private section is malformed.");
  return comment;
}

export function sshPublicKeyOf(private_key: string): string {
  const body = armorBody(private_key);
  try {
    const reader = new SshReader(body);
    if (!reader.magic(KEY_MAGIC))
      throw new Error("The SSH key is not an openssh-key-v1 text.");
    if (reader.text() !== NO_CIPHER || reader.text() !== NO_KDF)
      throw new Error("The SSH key is encrypted.");
    if (reader.text() !== NO_KDF_OPTIONS)
      throw new Error("The SSH key is encrypted.");
    if (reader.uint32() !== KEY_COUNT)
      throw new Error("The SSH key must hold one key.");
    const publicKey = readPublicBlob(reader.bytes());
    const section = reader.bytes();
    if (reader.rest().length)
      throw new Error("The SSH key holds trailing data.");
    return publicKeyLine(publicKey, readPrivateSection(section, publicKey));
  } finally {
    body.fill(0);
  }
}

export function sshFingerprintOf(public_key: string): string {
  const fields = public_key.trim().split(FIELD_SEPARATOR);
  if (
    fields.length < PUBLIC_KEY_FIELDS_MIN ||
    fields[0] !== KEY_TYPE ||
    !BASE64_TEXT.test(fields[1] ?? "")
  )
    throw new Error("The SSH public key is malformed.");
  const blob = Buffer.from(fields[1]!, "base64");
  readPublicBlob(blob);
  const digest = createHash("sha256").update(blob).digest("base64");
  return `${FINGERPRINT_PREFIX}${digest.replace(BASE64_PADDING, "")}`;
}
