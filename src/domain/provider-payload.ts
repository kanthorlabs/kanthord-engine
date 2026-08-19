import { z } from "zod";

export const providerKinds = ["llm", "git"] as const;
export type ProviderKind = (typeof providerKinds)[number];

export const gitForges = ["github", "gitlab", "bitbucket"] as const;
export type GitForge = (typeof gitForges)[number];

export const openAiCompatibleProvider = "openai-compatible";

export const llmPayload = z
  .object({
    provider: z.string().min(1),
    apiKey: z.string().min(1),
    defaultModel: z.string().min(1),
    baseUrl: z.string().min(1).nullable(),
  })
  .strict();
export type LlmPayload = z.infer<typeof llmPayload>;

export const gitHttpBasicPayload = z
  .object({
    transport: z.literal("http-basic"),
    forge: z.enum(gitForges),
    username: z.string().min(1),
    token: z.string().min(1),
  })
  .strict();

export const gitSshPayload = z
  .object({
    transport: z.literal("ssh"),
    privateKey: z.string().min(1),
  })
  .strict();

export const gitPayload = z.discriminatedUnion("transport", [
  gitHttpBasicPayload,
  gitSshPayload,
]);
export type GitPayload = z.infer<typeof gitPayload>;

export type ProviderPayload = LlmPayload | GitPayload;

export const llmProjection = z.strictObject({
  provider: z.string(),
  defaultModel: z.string(),
  baseUrl: z.string().nullable(),
});

export const gitProjection = z.strictObject({
  transport: z.enum(["http-basic", "ssh"]),
  forge: z.enum(gitForges).nullable(),
  username: z.string().nullable(),
});

export const providerProjection = z.union([llmProjection, gitProjection]);
export type ProviderProjection = z.infer<typeof providerProjection>;

export type BaseUrlRefusal = "base-url-required" | "base-url-not-allowed";

export function llmBaseUrlRefusal(
  provider: string,
  baseUrl: string | null,
): BaseUrlRefusal | null {
  if (provider === openAiCompatibleProvider) {
    return baseUrl === null ? "base-url-required" : null;
  }
  return baseUrl === null ? null : "base-url-not-allowed";
}

export type PayloadRefusal =
  | "kind-unknown"
  | "payload-invalid"
  | "private-key-encrypted"
  | "private-key-malformed";

export class PayloadError extends Error {
  readonly refusal: PayloadRefusal;
  readonly detail: string;

  constructor(refusal: PayloadRefusal, message: string, detail = "") {
    super(message);
    this.refusal = refusal;
    this.detail = detail;
  }
}

const payloadSchemas: Readonly<Record<ProviderKind, z.ZodType>> = Object.freeze(
  {
    llm: llmPayload,
    git: gitPayload,
  },
);

export function payloadSchemaFor(kind: ProviderKind): z.ZodType {
  const schema = payloadSchemas[kind];
  if (schema === undefined) {
    throw new PayloadError("kind-unknown", `${kind} is not a provider kind`);
  }
  return schema;
}

export function parsePayload(kind: "llm", value: unknown): LlmPayload;
export function parsePayload(kind: "git", value: unknown): GitPayload;
export function parsePayload(
  kind: ProviderKind,
  value: unknown,
): ProviderPayload;
export function parsePayload(
  kind: ProviderKind,
  value: unknown,
): ProviderPayload {
  const result = payloadSchemaFor(kind).safeParse(value);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new PayloadError(
      "payload-invalid",
      `the payload does not match the schema of kind ${kind}`,
      firstIssue === undefined
        ? ""
        : `${firstIssue.path.join(".")}.${firstIssue.message}`,
    );
  }
  const payload = result.data as ProviderPayload;
  if (kind === "git") {
    const git = payload as GitPayload;
    if (git.transport === "ssh") {
      const cipher = privateKeyCipher(git.privateKey);
      if (cipher !== null && cipher !== "none") {
        throw new PayloadError(
          "private-key-encrypted",
          "the private key is encrypted; kanthord runs ssh under BatchMode=yes and cannot supply a passphrase",
          cipher,
        );
      }
      if (cipher === null) {
        throw new PayloadError(
          "private-key-malformed",
          "the private key is not an unencrypted OpenSSH private key",
          "",
        );
      }
    }
  }
  return payload;
}

export function serializePayload(
  kind: ProviderKind,
  payload: ProviderPayload,
): string {
  if (kind === "llm") {
    const value = payload as LlmPayload;
    return JSON.stringify({
      provider: value.provider,
      apiKey: value.apiKey,
      defaultModel: value.defaultModel,
      baseUrl: value.baseUrl,
    });
  }
  const value = payload as GitPayload;
  if (value.transport === "http-basic") {
    return JSON.stringify({
      transport: value.transport,
      forge: value.forge,
      username: value.username,
      token: value.token,
    });
  }
  return JSON.stringify({
    transport: value.transport,
    privateKey: value.privateKey,
  });
}

export function deserializePayload(
  kind: ProviderKind,
  text: string,
): ProviderPayload {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PayloadError(
      "payload-invalid",
      "the stored payload is not JSON",
      "",
    );
  }
  return parsePayload(kind, value);
}

export function projectPayload(
  kind: ProviderKind,
  payload: ProviderPayload,
): ProviderProjection {
  if (kind === "llm") {
    const value = payload as LlmPayload;
    return {
      provider: value.provider,
      defaultModel: value.defaultModel,
      baseUrl: value.baseUrl,
    };
  }
  const value = payload as GitPayload;
  if (value.transport === "http-basic") {
    return {
      transport: value.transport,
      forge: value.forge,
      username: value.username,
    };
  }
  return { transport: "ssh", forge: null, username: null };
}

export function privateKeyCipher(privateKey: string): string | null {
  const match =
    /-----BEGIN OPENSSH PRIVATE KEY-----\n([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/.exec(
      privateKey,
    );
  if (match === null) {
    return null;
  }
  const body = match[1];
  if (body === undefined) {
    return null;
  }
  const decoded = Buffer.from(body.replace(/\n/g, ""), "base64");
  const magic = Buffer.from("openssh-key-v1\0", "utf8");
  if (decoded.length < 19 || !decoded.subarray(0, 15).equals(magic)) {
    return null;
  }
  const length = decoded.readUInt32BE(15);
  return decoded.subarray(19, 19 + length).toString("utf8");
}
