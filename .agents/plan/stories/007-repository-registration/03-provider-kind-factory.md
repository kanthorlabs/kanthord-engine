# Story 03 — The provider kind factory

Epic: `.agents/plan/epics/007-repository-registration.md`
Depends on: nothing in this epic.

`kind` dispatches to one schema, one serializer, one deserializer and one public projection. The table gains no column of any single kind. Pure domain, `zod` only.

## Change

### 1. `src/domain/provider-payload.ts` (new)

```ts
import { z } from "zod";

export const providerKinds = ["llm", "git"] as const;
export type ProviderKind = (typeof providerKinds)[number];

export const gitForges = ["github", "gitlab", "bitbucket"] as const;
export type GitForge = (typeof gitForges)[number];

export const llmPayload = z.object({
  provider: z.string().min(1),
  apiKey: z.string().min(1),
  defaultModel: z.string().min(1),
  baseUrl: z.string().min(1).nullable(),
});
export type LlmPayload = z.infer<typeof llmPayload>;

export const gitHttpBasicPayload = z.object({
  transport: z.literal("http-basic"),
  forge: z.enum(gitForges),
  username: z.string().min(1),
  token: z.string().min(1),
});

export const gitSshPayload = z.object({
  transport: z.literal("ssh"),
  privateKey: z.string().min(1),
});

export const gitPayload = z.discriminatedUnion("transport", [
  gitHttpBasicPayload,
  gitSshPayload,
]);
export type GitPayload = z.infer<typeof gitPayload>;

export type ProviderPayload = LlmPayload | GitPayload;

export const llmProjection = z.object({
  provider: z.string(),
  defaultModel: z.string(),
  baseUrl: z.string().nullable(),
});

export const gitProjection = z.object({
  transport: z.enum(["http-basic", "ssh"]),
  forge: z.enum(gitForges).nullable(),
  username: z.string().nullable(),
});

export const providerProjection = z.union([llmProjection, gitProjection]);
export type ProviderProjection = z.infer<typeof providerProjection>;

export type PayloadRefusal =
  | "kind-unknown"
  | "payload-invalid"
  | "private-key-encrypted"
  | "private-key-malformed";

export class PayloadError extends Error {
  readonly refusal: PayloadRefusal;
  readonly detail: string;
  constructor(refusal: PayloadRefusal, message: string, detail?: string);
}

export function payloadSchemaFor(kind: ProviderKind): z.ZodType;
export function parsePayload(
  kind: ProviderKind,
  value: unknown,
): ProviderPayload;
export function serializePayload(
  kind: ProviderKind,
  payload: ProviderPayload,
): string;
export function deserializePayload(
  kind: ProviderKind,
  text: string,
): ProviderPayload;
export function projectPayload(
  kind: ProviderKind,
  payload: ProviderPayload,
): ProviderProjection;
export function privateKeyCipher(privateKey: string): string | null;
```

**`payloadSchemaFor`** is a lookup on a frozen record, not a `switch`. A kind outside `providerKinds` throws `PayloadError("kind-unknown", `${kind} is not a provider kind`)`.

**`parsePayload`** runs `payloadSchemaFor(kind).safeParse(value)`. A failure throws `PayloadError("payload-invalid", "the payload does not match the schema of kind <kind>", <the first issue path joined by "." and its message>)`. For `kind === "git"` with `transport === "ssh"` it then runs the encrypted-key check below.

**The encrypted-key refusal.** `privateKeyCipher` returns the cipher name an OpenSSH private key declares, or `null` when the text is not an OpenSSH key. It never parses the key material.

1. Match `/-----BEGIN OPENSSH PRIVATE KEY-----\n([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/`. No match returns `null`.
2. Base64-decode the captured body with every `\n` removed.
3. The first fifteen bytes must equal `"openssh-key-v1\0"`. Otherwise return `null`.
4. Read a four-byte big-endian length at offset 15, then read that many bytes from offset 19 as UTF-8. That is the cipher name.

`parsePayload` refuses when the value is anything other than `"none"`:

```
PayloadError("private-key-encrypted",
  "the private key is encrypted; kanthord runs ssh under BatchMode=yes and cannot supply a passphrase",
  <the cipher name>)
```

It refuses when `privateKeyCipher` returns `null`:

```
PayloadError("private-key-malformed",
  "the private key is not an unencrypted OpenSSH private key", "")
```

A classic PEM key carrying `Proc-Type: 4,ENCRYPTED` returns `null` from step 1 and is therefore refused as malformed rather than as encrypted. That is correct and it is deliberate: the daemon accepts one key format, and a message naming the format is more useful than one naming the cipher of a format it will not read either way.

**`serializePayload`** is canonical, per `docs/proposal/phase-1/plan-format.md`. It writes `JSON.stringify` over a **freshly built object literal whose keys appear in the schema's declared order**, never over the parsed value, because a parsed object carries insertion order from the request body. The two orders are:

| kind and transport   | key order                                       |
| -------------------- | ----------------------------------------------- |
| `llm`                | `provider`, `apiKey`, `defaultModel`, `baseUrl` |
| `git` / `http-basic` | `transport`, `forge`, `username`, `token`       |
| `git` / `ssh`        | `transport`, `privateKey`                       |

No trailing newline, no indentation, no key sorting. The order is the declared order, and it is asserted byte for byte.

**`deserializePayload`** `JSON.parse`s and hands the result to `parsePayload`, so a stored payload is validated on the way out. A `JSON.parse` failure throws `PayloadError("payload-invalid", "the stored payload is not JSON", "")`. `docs/proposal/database/provider.md:33` calls a parse failure a configuration error, and the refusal names the kind so a caller can name the registration.

**`projectPayload`** returns, for `llm`, `{ provider, defaultModel, baseUrl }`; for `git` / `http-basic`, `{ transport: "http-basic", forge, username }`; for `git` / `ssh`, `{ transport: "ssh", forge: null, username: null }`.

The projection is built as a fresh literal naming each member. Never build it by deleting a key from the payload: a projection that starts from the secret and removes fields leaks whatever a later schema adds.

## Constraints

- The file imports `zod` and nothing else. `src/domain/**` may import only `domain/` and `zod`, enforced by `eslint.config.js:192-209`.
- No `node:crypto`, no `node:buffer` import. The base64 decode uses the global `Buffer`, which is available without an import and is not a module the domain rule bans. Use `Buffer.from(body, "base64")`.
- `src/domain/provider.ts` is **not** edited. `providerRow` already carries `kind: z.enum(["llm","git"])` and an opaque ciphertext, and `docs/proposal/database/provider.md:25` requires the table to carry no per-kind column. Adding a kind therefore adds a schema in this file and nothing in the row.
- No projection member is optional. `forge` and `username` are `null` for the ssh transport, because an absent key and a null value read differently through JSON and the response schema of Story 04 pins one of them.
- `serializePayload` never calls `JSON.stringify(payload)` directly.
- The file holds no `127.` and no `"localhost"` literal.

## Verify

`node --test src/domain/provider-payload.test.ts`

### The kind dispatch

- `providerKinds` deep-equals `["llm","git"]`, and it set-equals the `kind` enum of `providerRow` — read `providerRow.shape.kind.options` and compare as sorted arrays. The two vocabularies cannot drift.
- `payloadSchemaFor("llm")` and `payloadSchemaFor("git")` return different objects, and each call for one kind returns the same object.
- `payloadSchemaFor("slack" as never)` throws `PayloadError` with `refusal === "kind-unknown"`.

### The llm payload

- A payload `{ provider: "anthropic", apiKey: "sk-ant-x", defaultModel: "claude-opus-5", baseUrl: null }` parses.
- The same with `baseUrl: "https://example.invalid/v1"` parses.
- A missing key loop: delete each of the four keys in turn and assert `parsePayload` throws `refusal === "payload-invalid"`, with `detail` beginning with the deleted key name.
- `apiKey: ""` throws `payload-invalid`. An empty secret is not a secret.
- `baseUrl: ""` throws. The member is nullable, not emptiable.

### The git payload

- `{ transport: "http-basic", forge: "github", username: "kanthord-bot", token: "ghp_x" }` parses. The same for `gitlab` and for `bitbucket`.
- `forge: "codeberg"` throws `payload-invalid`. The forge set is closed here, which is the counterpart to EPIC 006 Story 03's note that an unknown forge is not a refusal inside the git service.
- `{ transport: "ssh", privateKey: <an unencrypted ed25519 key> }` parses.
- `{ transport: "ssh", forge: "github", privateKey: "…" }` throws `payload-invalid`. The two transports share no field, so a stray `forge` is a rejection rather than an ignored extra — assert this explicitly, because `z.object` strips an unknown key by default and the test is what pins the strictness the schema needs. Declare both members of the union with `.strict()`.
- `{ transport: "https", … }` throws `payload-invalid`. The discriminant is `http-basic`, per `docs/proposal/database/provider.md:52`.
- `token: ""` throws, and `privateKey: ""` throws.

### The private key rules

Every key in this section is generated once by the test into its own `mkdtempSync` directory with `resolveTools().paths.sshKeygen` from `test/helpers/remote/tools.ts` — never a bare `ssh-keygen`, so an absent tool refuses with EPIC 005's named `ToolError`, and the directory is removed. The three keys are: an unencrypted ed25519 key, the same key type with a passphrase, and an unencrypted RSA key.

- `privateKeyCipher(<unencrypted ed25519>)` equals `"none"`. So does `privateKeyCipher(<unencrypted rsa>)`.
- `privateKeyCipher(<passphrase-protected ed25519>)` equals `"aes256-ctr"`. Assert it is a non-empty string other than `"none"` as well, so a change in `ssh-keygen`'s default cipher does not turn this into a false pass.
- `privateKeyCipher("not a key")` is `null`. `privateKeyCipher("-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----")` is `null` — a classic PEM is not an OpenSSH key.
- `parsePayload("git", { transport: "ssh", privateKey: <passphrase key> })` throws `refusal === "private-key-encrypted"`, and `detail` equals the cipher name.
- `parsePayload("git", { transport: "ssh", privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nQUJD\n-----END OPENSSH PRIVATE KEY-----" })` throws `refusal === "private-key-malformed"` — the body decodes but carries no `openssh-key-v1` magic.
- A key whose base64 body contains embedded newlines parses. `ssh-keygen` wraps at 70 columns, so this is the ordinary case and not an edge one.
- `parsePayload("git", { transport: "http-basic", … })` never calls `privateKeyCipher` — assert by passing a payload whose `token` is a passphrase-protected key text and expecting a successful parse.

### Canonical serialization, exact bytes

- `serializePayload("llm", …)` equals exactly `{"provider":"anthropic","apiKey":"sk-ant-x","defaultModel":"claude-opus-5","baseUrl":null}`.
- `serializePayload("git", <http-basic>)` equals exactly `{"transport":"http-basic","forge":"github","username":"kanthord-bot","token":"ghp_x"}`.
- `serializePayload("git", <ssh>)` equals exactly `{"transport":"ssh","privateKey":"<the key with \n escaped>"}`.
- **Key order does not follow the input.** Build the llm payload with the literal keys in the order `baseUrl`, `defaultModel`, `apiKey`, `provider`, parse it, serialize it, and assert the same byte string as above. This is the assertion that makes the serializer canonical rather than incidentally ordered.
- `serializePayload` output ends with `}` and contains no `\n`.
- Round trip: for each of the four payloads above, `deserializePayload(kind, serializePayload(kind, parsed))` deep-equals `parsed`, and serializing the round-tripped value yields the identical byte string. Byte-identical round trip is the determinism rule of `AGENTS.md`.
- `deserializePayload("llm", "{")` throws `payload-invalid` with the message `"the stored payload is not JSON"`.
- `deserializePayload("git", '{"transport":"ssh"}')` throws `payload-invalid`. A stored payload is validated on the way out.

### The public projection

- `projectPayload("llm", …)` deep-equals `{ provider: "anthropic", defaultModel: "claude-opus-5", baseUrl: null }`, and `Object.keys` deep-equals `["provider","defaultModel","baseUrl"]`.
- `projectPayload("git", <http-basic>)` deep-equals `{ transport: "http-basic", forge: "github", username: "kanthord-bot" }`.
- `projectPayload("git", <ssh>)` deep-equals `{ transport: "ssh", forge: null, username: null }`.
- **No credential field survives, asserted field by field.** For each of the four payloads, assert `Object.hasOwn(projection, "apiKey") === false`, `Object.hasOwn(projection, "token") === false`, and `Object.hasOwn(projection, "privateKey") === false`. Then assert `JSON.stringify(projection)` does not include the secret value. The three `hasOwn` assertions are the field-by-field half the epic requires, and the string search is the additional net, not the test.
- `providerProjection.safeParse(projectPayload(kind, payload)).success` is `true` for all four.

### E2E — scenario `E7-03`

File `scripts/e2e/007/03-provider-kind-factory.e2e.ts`. This story has no remote surface of its own, so the scenario proves the factory against the **real** credential rather than a fixture value.

- `parsePayload("git", { transport: "http-basic", forge: "github", username: "x-access-token", token: env.ghToken })` parses the real token from `.env.e2e`.
- `serializePayload` on it produces a byte string whose `JSON.parse` round trip is deep-equal, and whose `deserializePayload` round trip re-serializes byte-identically. A real `github_pat_…` value contains `_` and `.`, so this proves the canonical form survives the characters the fixture tokens do not carry.
- `projectPayload` on it yields `{ transport: "http-basic", forge: "github", username: "x-access-token" }` and the serialized projection does not include `env.ghToken`.
- The scenario performs no network call and creates no ref.

`npm run verify` exits 0.

Proof: contributes `src/domain/provider-payload.test.ts`. It is not matched by the epic Proof globs, which name `src/commands/provider/**` and `src/queries/provider/**`; Story 13 records the widening.
