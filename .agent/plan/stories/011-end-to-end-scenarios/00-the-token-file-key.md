# Story 00 — The `http.tokenFile` key

Epic: `.agent/plan/epics/011-end-to-end-scenarios.md`
Depends on: EPIC 010.6 (sequence order).

A product change, ratified by Ulrich on 2026-08-06. `http.token` is the only way to
configure the bearer token today, so every deployment writes the secret into the
configuration file. `http.tokenFile` mirrors `masterKeyFile`, which already solves the same
problem for the master key. Story 10 then asserts the token is **absent** from the daemon
configuration rather than merely redacted in it.

## Change

### Changed — `src/services/config/convict.ts:60`

Add one key after `token`, inside the `http` block, mirroring `masterKeyFile` at
`convict.ts:48-52`:

```ts
      token: { format: "String", default: "", env: "KANTHORD_HTTP_TOKEN" },
      tokenFile: {
        format: "String",
        default: "",
        env: "KANTHORD_HTTP_TOKEN_FILE",
      },
```

### Changed — `src/services/config/convict.ts:196-214` — resolution

Add `readTokenFile`, mirroring the `masterKeyFile` read exactly:

```ts
function readTokenFile(path: string): Readonly<{ token: string; mode: number }>;
```

- `statSync(path)` and `readFileSync(path, "utf8")`. `ENOENT` throws
  ``new ConfigError("config-invalid", `http.tokenFile not found: ${path}`)``, the same
  shape as `convict.ts:207-210`.
- The value is the file content with **exactly one** trailing `\n` removed, the rule
  `src/cli/credential/register.ts:37-39` already uses for a secret file. No other trimming,
  because a token may legally begin or end with a space.
- `mode` is `stat.mode`.

`load` resolves the token **before** `assertStartable`, and the resolved value is what
reaches `Settings`.

### Changed — `src/services/config/index.ts:1-6` — `HttpSettings` is unchanged

`HttpSettings.token` stays a `string`, and `tokenFile` never reaches `Settings`. Everything
downstream — `src/main.ts:288`, `src/http/server/app.ts:55`, `src/http/server/auth.ts:35` —
sees exactly what it sees today. This is what keeps the change surgical.

### Changed — `src/services/config/refusals.ts`

`StartableInput` gains two fields:

```ts
export type StartableInput = Readonly<{
  masterKey: string;
  masterKeyFile: string;
  masterKeyFileMode: number | undefined;
  bind: string;
  token: string;
  tokenFile: string;
  tokenFileMode: number | undefined;
}>;
```

`assertStartable` gains two refusals, inserted **after** the `masterKeyFile` mode check at
`refusals.ts:45` and **before** the loopback check at `refusals.ts:47`, so the message order
for an existing configuration does not move:

```ts
if (input.token.length > 0 && input.tokenFile.length > 0) {
  throw new ConfigError(
    "config-refused",
    "http.token and http.tokenFile are both set; configure exactly one",
  );
}

if (
  input.tokenFile.length > 0 &&
  input.tokenFileMode !== undefined &&
  (input.tokenFileMode & 0o777) !== 0o600
) {
  const octal = (input.tokenFileMode & 0o777).toString(8).padStart(3, "0");
  throw new ConfigError(
    "config-refused",
    `http.tokenFile must have mode 0600; found 0${octal}`,
  );
}
```

**There is no "neither is set" refusal.** An empty token is legal on a loopback bind —
`src/http/server/auth.ts:35-51` disables authentication when the configured token is empty —
and that behaviour does not change. `masterKey` has such a refusal because a daemon cannot
run without a master key; a token is optional on loopback.

`input.token` at `refusals.ts:47` is the **resolved** token, so
`a non-loopback bind address requires http.token` still fires when only `tokenFile` was
configured and the file was empty. The message string does not change, because Story 05 and
Story 08 assert it verbatim.

## Constraints

- Surgical. Do not restructure `buildSchema`, `assertStartable` or the `load` method. Add
  the key, the reader, and the two refusals.
- `{ allowed: "strict" }` at `convict.ts:187` means an unknown key is already rejected, so
  adding the key is what makes it configurable. Nothing else is needed for validation.
- The resolved token is a secret. Do not log it, and do not put it in a `ConfigError`
  message.
- `Settings` and every consumer of it are unchanged. A change to `src/http/server/**` in
  this story is a defect.

## Verify

`node --test src/services/config/refusals.test.ts` — new cases:

- `token: "t"`, `tokenFile: "/x"` throws `config-refused` with message
  `http.token and http.tokenFile are both set; configure exactly one`.
- `tokenFile: "/x"`, `tokenFileMode: 0o644` throws `config-refused` with message
  `http.tokenFile must have mode 0600; found 0644`.
- `tokenFile: "/x"`, `tokenFileMode: 0o600` passes.
- `tokenFile: ""`, `token: ""`, `bind: "127.0.0.1"` passes — an empty token stays legal on
  loopback.
- `tokenFile: ""`, `token: ""`, `bind: "203.0.113.1"` still throws
  `a non-loopback bind address requires http.token`, byte for byte.
- the two `masterKey` refusals fire before the two token refusals — asserted by a config
  that violates one of each, whose message is the `masterKey` one.

`node --test src/services/config/convict.test.ts` — new cases, each on a `mkdtemp`
directory:

- a config with `http.tokenFile` pointing at a mode-`0600` file holding `"s3cret\n"`
  produces `settings.http.token === "s3cret"` — exactly one trailing newline removed.
- a file holding `"s3cret\n\n"` produces `"s3cret\n"`.
- a file holding `" pad "` produces `" pad "` — no other trimming.
- a missing `http.tokenFile` throws `config-invalid` with
  `http.tokenFile not found: <path>`.
- `KANTHORD_HTTP_TOKEN_FILE` sets the key from the environment.
- `Object.hasOwn(settings.http, "tokenFile")` is `false` — the key never reaches `Settings`.
- an existing config that sets `http.token` and no `tokenFile` produces the same `Settings`
  as before the change — the regression guard.

`npm run verify` exits 0.

Proof: this story delivers no `PASS` line of its own. It is the precondition of Story 10's
`no-disclosure-config` assertion, which is part of
`node scripts/e2e/run.mjs P1-E4`.
