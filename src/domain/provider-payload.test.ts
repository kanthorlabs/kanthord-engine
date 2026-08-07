import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerRow } from "./provider.ts";
import { resolveTools } from "../../test/helpers/remote/tools.ts";
import {
  PayloadError,
  deserializePayload,
  gitProjection,
  llmProjection,
  parsePayload,
  payloadSchemaFor,
  privateKeyCipher,
  projectPayload,
  providerKinds,
  providerProjection,
  serializePayload,
} from "./provider-payload.ts";
import type { ProviderKind, ProviderPayload } from "./provider-payload.ts";

const LLM_SERIALIZED =
  '{"provider":"anthropic","apiKey":"sk-ant-x","defaultModel":"claude-opus-5","baseUrl":null}';
const HTTP_BASIC_SERIALIZED =
  '{"transport":"http-basic","forge":"github","username":"kanthord-bot","token":"ghp_x"}';

function capturedError(action: () => unknown): PayloadError {
  try {
    action();
  } catch (error) {
    assert.ok(
      error instanceof PayloadError,
      `expected a PayloadError, got: ${String(error)}`,
    );
    return error;
  }
  assert.fail("expected a PayloadError");
}

function generateKey(
  type: "ed25519" | "rsa",
  passphrase: string,
  file: string,
): string {
  const args = ["-t", type];
  if (type === "rsa") {
    args.push("-b", "2048");
  }
  execFileSync(
    resolveTools().paths.sshKeygen,
    [...args, "-N", passphrase, "-f", file],
    { env: {}, encoding: "utf8" },
  );
  return readFileSync(file, "utf8");
}

describe("src/domain/provider-payload.test", () => {
  const llmInput = {
    provider: "anthropic",
    apiKey: "sk-ant-x",
    defaultModel: "claude-opus-5",
    baseUrl: null,
  };
  const llmWithBaseUrlInput = {
    provider: "anthropic",
    apiKey: "sk-ant-x",
    defaultModel: "claude-opus-5",
    baseUrl: "https://example.invalid/v1",
  };
  const httpBasicInput = {
    transport: "http-basic",
    forge: "github",
    username: "kanthord-bot",
    token: "ghp_x",
  };
  const sshInput = { transport: "ssh", privateKey: "" };

  const parsedLlm = parsePayload("llm", llmInput);
  const parsedLlmWithBaseUrl = parsePayload("llm", llmWithBaseUrlInput);
  const parsedHttpBasic = parsePayload("git", httpBasicInput);

  let unencryptedEd25519 = "";
  let passphraseEd25519 = "";
  let unencryptedRsa = "";
  const keyDirectory = mkdtempSync(
    join(tmpdir(), "kanthord-provider-payload-"),
  );

  before(() => {
    unencryptedEd25519 = generateKey(
      "ed25519",
      "",
      join(keyDirectory, "ed25519"),
    );
    passphraseEd25519 = generateKey(
      "ed25519",
      "kanthord-passphrase",
      join(keyDirectory, "encrypted"),
    );
    unencryptedRsa = generateKey("rsa", "", join(keyDirectory, "rsa"));
    sshInput.privateKey = unencryptedEd25519;
  });

  after(() => {
    rmSync(keyDirectory, { recursive: true, force: true });
  });

  describe("the kind dispatch", () => {
    it("providerKinds deep-equals the row kind enum", () => {
      assert.deepEqual(providerKinds, ["llm", "git"]);
      const rowKinds = [...providerRow.shape.kind.options].sort();
      const payloadKinds = [...providerKinds].sort();
      assert.deepEqual(payloadKinds, rowKinds);
    });

    it("payloadSchemaFor returns one object per kind, and the two kinds differ", () => {
      const llmSchema = payloadSchemaFor("llm");
      assert.equal(payloadSchemaFor("llm"), llmSchema);
      const gitSchema = payloadSchemaFor("git");
      assert.equal(payloadSchemaFor("git"), gitSchema);
      assert.notEqual(llmSchema, gitSchema);
    });

    it("payloadSchemaFor throws kind-unknown for a kind outside the set", () => {
      const error = capturedError(() => payloadSchemaFor("slack" as never));
      assert.equal(error.refusal, "kind-unknown");
      assert.equal(error.message, "slack is not a provider kind");
    });
  });

  describe("the llm payload", () => {
    it("parses with a null baseUrl", () => {
      assert.deepEqual(parsePayload("llm", llmInput), llmInput);
    });

    it("parses with an http baseUrl", () => {
      assert.deepEqual(
        parsePayload("llm", llmWithBaseUrlInput),
        llmWithBaseUrlInput,
      );
    });

    it("refuses each missing key with payload-invalid naming the key", () => {
      for (const key of ["provider", "apiKey", "defaultModel", "baseUrl"]) {
        const incomplete: Record<string, unknown> = { ...llmInput };
        delete incomplete[key];
        const error = capturedError(() => parsePayload("llm", incomplete));
        assert.equal(error.refusal, "payload-invalid");
        assert.ok(
          error.detail.startsWith(`${key}.`),
          `detail ${JSON.stringify(error.detail)} does not name ${key}`,
        );
      }
    });

    it("refuses an empty apiKey", () => {
      const error = capturedError(() =>
        parsePayload("llm", { ...llmInput, apiKey: "" }),
      );
      assert.equal(error.refusal, "payload-invalid");
      assert.ok(error.detail.startsWith("apiKey"));
    });

    it("refuses an empty baseUrl", () => {
      const error = capturedError(() =>
        parsePayload("llm", { ...llmInput, baseUrl: "" }),
      );
      assert.equal(error.refusal, "payload-invalid");
    });
  });

  describe("the git payload", () => {
    it("parses http-basic for each forge", () => {
      for (const forge of ["github", "gitlab", "bitbucket"] as const) {
        const parsed = parsePayload("git", {
          transport: "http-basic",
          forge,
          username: "kanthord-bot",
          token: "ghp_x",
        });
        assert.equal(parsed.transport, "http-basic");
      }
    });

    it("refuses a forge outside the closed set", () => {
      const error = capturedError(() =>
        parsePayload("git", {
          transport: "http-basic",
          forge: "codeberg",
          username: "kanthord-bot",
          token: "ghp_x",
        }),
      );
      assert.equal(error.refusal, "payload-invalid");
      assert.equal(
        error.message,
        "the payload does not match the schema of kind git",
      );
    });

    it("parses ssh with an unencrypted ed25519 key", () => {
      const parsed = parsePayload("git", sshInput);
      assert.equal(parsed.transport, "ssh");
    });

    it("refuses a stray forge on the ssh transport", () => {
      const error = capturedError(() =>
        parsePayload("git", {
          transport: "ssh",
          forge: "github",
          privateKey: unencryptedEd25519,
        }),
      );
      assert.equal(error.refusal, "payload-invalid");
    });

    it("refuses a transport outside the discriminated union", () => {
      const error = capturedError(() =>
        parsePayload("git", {
          transport: "https",
          forge: "github",
          username: "kanthord-bot",
          token: "ghp_x",
        }),
      );
      assert.equal(error.refusal, "payload-invalid");
    });

    it("refuses an empty token and an empty privateKey", () => {
      const tokenError = capturedError(() =>
        parsePayload("git", { ...httpBasicInput, token: "" }),
      );
      assert.equal(tokenError.refusal, "payload-invalid");
      const keyError = capturedError(() =>
        parsePayload("git", { transport: "ssh", privateKey: "" }),
      );
      assert.equal(keyError.refusal, "payload-invalid");
    });
  });

  describe("the private key rules", () => {
    it("reads the cipher of an unencrypted ed25519 key", () => {
      assert.equal(privateKeyCipher(unencryptedEd25519), "none");
    });

    it("reads the cipher of an unencrypted rsa key", () => {
      assert.equal(privateKeyCipher(unencryptedRsa), "none");
    });

    it("reads the cipher of a passphrase-protected key", () => {
      const cipher = privateKeyCipher(passphraseEd25519);
      assert.ok(cipher !== "" && cipher !== "none");
      assert.equal(cipher, "aes256-ctr");
    });

    it("returns null for text that is not an OpenSSH key", () => {
      assert.equal(privateKeyCipher("not a key"), null);
      assert.equal(
        privateKeyCipher(
          "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
        ),
        null,
      );
    });

    it("refuses a passphrase-protected key as encrypted and names the cipher", () => {
      const error = capturedError(() =>
        parsePayload("git", {
          transport: "ssh",
          privateKey: passphraseEd25519,
        }),
      );
      assert.equal(error.refusal, "private-key-encrypted");
      assert.equal(error.detail, privateKeyCipher(passphraseEd25519));
    });

    it("refuses an OpenSSH body without the key magic as malformed", () => {
      const error = capturedError(() =>
        parsePayload("git", {
          transport: "ssh",
          privateKey:
            "-----BEGIN OPENSSH PRIVATE KEY-----\nQUJD\n-----END OPENSSH PRIVATE KEY-----",
        }),
      );
      assert.equal(error.refusal, "private-key-malformed");
      assert.equal(error.detail, "");
    });

    it("parses a key whose base64 body carries embedded newlines", () => {
      assert.ok(unencryptedEd25519.includes("\n"));
      const parsed = parsePayload("git", sshInput);
      assert.equal(parsed.transport, "ssh");
    });

    it("never inspects the token on the http-basic transport", () => {
      const parsed = parsePayload("git", {
        transport: "http-basic",
        forge: "github",
        username: "kanthord-bot",
        token: passphraseEd25519,
      });
      assert.equal(parsed.transport, "http-basic");
    });
  });

  describe("canonical serialization, exact bytes", () => {
    it("serializes the llm payload in declared key order", () => {
      assert.equal(serializePayload("llm", parsedLlm), LLM_SERIALIZED);
    });

    it("serializes the http-basic payload in declared key order", () => {
      assert.equal(
        serializePayload("git", parsedHttpBasic),
        HTTP_BASIC_SERIALIZED,
      );
    });

    it("serializes the ssh payload with the key escaped byte for byte", () => {
      const parsedSsh = parsePayload("git", sshInput);
      assert.equal(
        serializePayload("git", parsedSsh),
        `{"transport":"ssh","privateKey":${JSON.stringify(unencryptedEd25519)}}`,
      );
    });

    it("key order does not follow the input order", () => {
      const reordered = parsePayload("llm", {
        baseUrl: null,
        defaultModel: "claude-opus-5",
        apiKey: "sk-ant-x",
        provider: "anthropic",
      });
      assert.equal(serializePayload("llm", reordered), LLM_SERIALIZED);
    });

    it("output ends with a brace and contains no newline", () => {
      const parsedSsh = parsePayload("git", sshInput);
      for (const bytes of [
        serializePayload("llm", parsedLlm),
        serializePayload("git", parsedHttpBasic),
        serializePayload("git", parsedSsh),
      ]) {
        assert.ok(bytes.endsWith("}"));
        assert.ok(!bytes.includes("\n"));
      }
    });

    it("round trips every payload byte-identically", () => {
      const reordered = parsePayload("llm", {
        baseUrl: null,
        defaultModel: "claude-opus-5",
        apiKey: "sk-ant-x",
        provider: "anthropic",
      });
      const parsedSsh = parsePayload("git", sshInput);
      const subjects: Readonly<
        { kind: ProviderKind; payload: ProviderPayload }[]
      > = [
        { kind: "llm", payload: parsedLlm },
        { kind: "llm", payload: reordered },
        { kind: "git", payload: parsedHttpBasic },
        { kind: "git", payload: parsedSsh },
      ];
      for (const subject of subjects) {
        const bytes = serializePayload(subject.kind, subject.payload);
        const restored = deserializePayload(subject.kind, bytes);
        assert.deepEqual(restored, subject.payload);
        assert.equal(serializePayload(subject.kind, restored), bytes);
      }
    });

    it("refuses a stored payload that is not JSON", () => {
      const error = capturedError(() => deserializePayload("llm", "{"));
      assert.equal(error.refusal, "payload-invalid");
      assert.equal(error.message, "the stored payload is not JSON");
    });

    it("validates a stored payload on the way out", () => {
      const error = capturedError(() =>
        deserializePayload("git", '{"transport":"ssh"}'),
      );
      assert.equal(error.refusal, "payload-invalid");
    });
  });

  describe("the public projection", () => {
    it("projects the llm payload without the secret", () => {
      const projection = projectPayload("llm", parsedLlm);
      assert.deepEqual(projection, {
        provider: "anthropic",
        defaultModel: "claude-opus-5",
        baseUrl: null,
      });
      assert.deepEqual(Object.keys(projection), [
        "provider",
        "defaultModel",
        "baseUrl",
      ]);
    });

    it("projects the http-basic payload without the token", () => {
      assert.deepEqual(projectPayload("git", parsedHttpBasic), {
        transport: "http-basic",
        forge: "github",
        username: "kanthord-bot",
      });
    });

    it("projects the ssh payload with null forge and username", () => {
      const parsedSsh = parsePayload("git", sshInput);
      assert.deepEqual(projectPayload("git", parsedSsh), {
        transport: "ssh",
        forge: null,
        username: null,
      });
    });

    it("no credential field survives in any projection", () => {
      const parsedSsh = parsePayload("git", sshInput);
      const subjects: Readonly<
        { kind: ProviderKind; payload: ProviderPayload; secret: string }[]
      > = [
        { kind: "llm", payload: parsedLlm, secret: "sk-ant-x" },
        { kind: "llm", payload: parsedLlmWithBaseUrl, secret: "sk-ant-x" },
        { kind: "git", payload: parsedHttpBasic, secret: "ghp_x" },
        { kind: "git", payload: parsedSsh, secret: unencryptedEd25519 },
      ];
      for (const subject of subjects) {
        const projection = projectPayload(subject.kind, subject.payload);
        assert.equal(Object.hasOwn(projection, "apiKey"), false);
        assert.equal(Object.hasOwn(projection, "token"), false);
        assert.equal(Object.hasOwn(projection, "privateKey"), false);
        assert.ok(!JSON.stringify(projection).includes(subject.secret));
      }
    });

    it("llmProjection and gitProjection each reject an unknown key", () => {
      const llmProjected = projectPayload("llm", parsedLlm);
      assert.equal(
        llmProjection.safeParse({ ...llmProjected, extra: true }).success,
        false,
      );
      const gitProjected = projectPayload("git", parsedHttpBasic);
      assert.equal(
        gitProjection.safeParse({ ...gitProjected, extra: true }).success,
        false,
      );
    });

    it("every projection satisfies the public response schema", () => {
      const parsedSsh = parsePayload("git", sshInput);
      const subjects: Readonly<
        { kind: ProviderKind; payload: ProviderPayload }[]
      > = [
        { kind: "llm", payload: parsedLlm },
        { kind: "llm", payload: parsedLlmWithBaseUrl },
        { kind: "git", payload: parsedHttpBasic },
        { kind: "git", payload: parsedSsh },
      ];
      for (const subject of subjects) {
        const projection = projectPayload(subject.kind, subject.payload);
        assert.equal(providerProjection.safeParse(projection).success, true);
      }
    });
  });
});
