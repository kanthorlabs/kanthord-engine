# Story 4 — The auth service enumerates the oauth flows and pins a method

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`
Depends on: nothing in this epic. Do this before Story 5.

## Verified library facts this story encodes

Read from `@earendil-works/pi-ai@0.84.1` and confirmed by running the installed package.
Do not re-derive them; do not widen them.

- Seven builtin providers carry `auth.oauth`: `anthropic`, `github-copilot`, `kimi-coding`,
  `openai-codex`, `openrouter`, `radius` and `xai`.
- **Only six are admitted.** `getBuiltinProviders()` returns 39 ids and `builtinProviders()`
  returns 40; the one difference is `radius`, which is therefore absent from the catalogue,
  fails the `catalog.has` gate in `provider.register`, and carries zero builtin models. The
  admitted set is the intersection, so `radius` is excluded (**B5**).
- `lazyOAuth` (`dist/auth/helpers.js:38-52`) copies `name`, `isSubscription` and
  `loginLabel` onto the wrapper as plain properties. Reading any of the three loads no
  flow module. Only `login`, `refresh` and `toAuth` trigger the dynamic import.
- Per-vendor eager values:

  | id               | `oauth.name`                   | `isSubscription` | `loginLabel`                            |
  | ---------------- | ------------------------------ | ---------------- | --------------------------------------- |
  | `anthropic`      | `"Anthropic (Claude Pro/Max)"` | `true`           | `undefined`                             |
  | `github-copilot` | `"GitHub Copilot"`             | `true`           | `undefined`                             |
  | `kimi-coding`    | `"Kimi Code (subscription)"`   | `true`           | `"Sign in with Kimi Code"`              |
  | `openai-codex`   | `"OpenAI (ChatGPT Plus/Pro)"`  | `true`           | `undefined`                             |
  | `openrouter`     | `"OpenRouter OAuth"`           | `undefined`      | `"Sign in with OpenRouter"`             |
  | `radius`         | `"Radius"`                     | `undefined`      | `undefined`                             |
  | `xai`            | `"xAI (Grok/X subscription)"`  | `true`           | `"Sign in with SuperGrok or X Premium"` |

- Only **two** of the seven flows ever issue a `select` prompt: `openai-codex`
  (`dist/auth/oauth/openai-codex.js:429-436`) and `radius`
  (`dist/auth/oauth/radius.js:288-298`). The other five never offer a method choice.
- The option ids are exactly `"browser"` and `"device_code"` for `openai-codex`, and
  `"browser"` and `"device-code"` for `radius`. The underscore/hyphen split is real.
- `openai-codex` carries **no** `auth.apiKey`. It is oauth-only.
- The flow modules under `dist/auth/oauth/` have no `exports` entry. A deep import fails
  with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The only way to observe a prompt is to call
  `provider.auth.oauth.login(interaction)`.

## Change

### `src/services/provider-auth/index.ts`

Append to the existing file. Do not modify the EPIC 044 exports above.

```ts
export const deviceCodeOptionIds = ["device-code", "device_code"] as const;
export const browserOptionId = "browser";

export type LoginMethod = "manual-code" | "device-code";

export type OauthVendor = Readonly<{
  id: string;
  label: string;
  isSubscription: boolean;
}>;

export type LoginRefusal =
  | "provider-not-oauth-capable"
  | "login-method-unavailable"
  | "login-input-required";

export class LoginError extends Error {
  readonly refusal: LoginRefusal;
  readonly detail: string;

  constructor(refusal: LoginRefusal, message: string, detail = "") {
    super(message);
    this.name = "LoginError";
    this.refusal = refusal;
    this.detail = detail;
  }
}
```

Extend the `ProviderAuth` interface (`src/services/provider-auth/index.ts:35-37`) with one
synchronous member. Story 5 adds the two login methods to the same interface.

```ts
export interface ProviderAuth {
  probe(row: ProviderAuthRow, signal: AbortSignal): Promise<ProbeOutcome>;
  oauthVendors(): readonly OauthVendor[];
}
```

**Widening the interface breaks every existing test double.** Two files build a
`ProviderAuth` fake that implements `probe` alone:
`src/queries/provider/verify-provider.test.ts` and
`src/http/server/credential/verify-provider.test.ts`. Both stop type-checking the moment
this member lands, so `npm run verify` fails unless they are updated **in this story**.

Add a shared helper `test/helpers/provider-auth.ts` exporting
`createFakeProviderAuth(overrides: Partial<ProviderAuth> = {}): ProviderAuth`, which
supplies a default for every member (`probe` resolving a fixed outcome, `oauthVendors`
returning `[]`, and in Story 5 the three login members). Point both existing test files at
it. Story 5 then extends one helper rather than chasing the same two files again.

`deviceCodeOptionIds` holds both spellings sorted bytewise, so a lookup is a membership
test and the array is the single place a third spelling would be added.

### `src/services/provider-auth/pi-ai.ts`

1. Add the exported option-answering rule, above the `PiAiProviderAuth` class:

   ```ts
   export function chooseOptionId(
     vendorId: string,
     optionIds: readonly string[],
   ): string {
     const device = optionIds.find((id) =>
       (deviceCodeOptionIds as readonly string[]).includes(id),
     );
     if (device !== undefined) return device;
     if (optionIds.includes(browserOptionId)) return browserOptionId;
     throw new LoginError(
       "login-method-unavailable",
       `the ${vendorId} login offers no recognized method`,
       optionIds.join(","),
     );
   }
   ```

   There is no default branch and no fall-through: an option set carrying neither a
   recognized device spelling nor `browser` refuses, and `detail` lists the exact ids seen,
   joined by `,` in the order the library offered them.

2. Add the `oauthVendors()` method to `PiAiProviderAuth`. It is **synchronous**, and it
   reads only the three eager `lazyOAuth` properties, so no flow module loads:

   The set is the **intersection** of two library-derived sets: providers carrying
   `auth.oauth`, and providers the catalogue carries. `getBuiltinProviders()` returns 39 ids
   while `builtinProviders()` returns 40, and the difference is `radius`, which is therefore
   excluded (**B5**). Build the catalogue side from `getBuiltinProviders()` directly — do
   **not** inject `ModelCatalog`, which would make one service depend on another's
   implementation choice.

   ```ts
   const catalogued = new Set<string>(getBuiltinProviders());

   oauthVendors(): readonly OauthVendor[] {
     return builtinProviders()
       .filter((provider) => provider.auth.oauth !== undefined)
       .filter((provider) => catalogued.has(provider.id))
       .map((provider) => {
         const oauth = provider.auth.oauth as OAuthAuth;
         return {
           id: provider.id,
           label: oauth.loginLabel ?? oauth.name,
           isSubscription: oauth.isSubscription === true,
         };
       })
       .sort((left, right) =>
         Buffer.compare(
           Buffer.from(left.id, "utf8"),
           Buffer.from(right.id, "utf8"),
         ),
       );
   }
   ```

   Import `OAuthAuth` as a type from the root entry `"@earendil-works/pi-ai"`. It is not
   reachable from `"@earendil-works/pi-ai/oauth"` — that subpath is a type-only legacy
   compat entry and carries none of these types.

   `isSubscription === true` normalizes the optional to a boolean, because `openrouter`
   and `radius` leave it `undefined`. The bytewise sort matches
   `PiAiModelCatalog.staticProviders` (`src/services/model-catalog/pi-ai.ts:56-58`) so the
   catalogue join of Story 9 is order-stable.

### `src/services/provider-auth/pi-ai.test.ts`

Add two `describe` blocks after the existing ones. They run against the **real** installed
library, matching the existing convention in this file (the suite already pins pi-ai's
error format at `:430-431`).

```ts
describe("the oauth vendor set", () => { … });
describe("the login method rule", () => { … });
```

**Vendor-set tests:**

1. `it("derives the admitted set from the library, not from a list")` — build
   `new PiAiProviderAuth()`, call `oauthVendors()`, and assert the ids deep-equal
   `["anthropic","github-copilot","kimi-coding","openai-codex","openrouter","xai"]` — **six,
   without `radius`**. Then compute the expectation independently in the test from
   `builtinProviders().filter((p) => p.auth.oauth !== undefined).filter((p) => getBuiltinProviders().includes(p.id)).map((p) => p.id).sort(bytewise)`
   and assert the two agree. A rename in `pi-ai` fails both halves.
   1b. `it("excludes radius because the catalogue does not carry it")` — assert
   `builtinProviders().some((p) => p.id === "radius")` is `true`,
   `getBuiltinProviders().includes("radius")` is `false`, and `radius` is absent from
   `oauthVendors()`. Assert `getBuiltinModels("radius")` is empty, which is the second
   reason it could never register. A library change that catalogues `radius` fails this
   test and forces a deliberate re-decision rather than silently widening the set.
2. `it("reads the eager oauth properties without loading a flow module")` — assert
   `oauthVendors()` returns an array rather than a promise, **and** assert the stronger
   property directly: build a provider whose `auth.oauth` is a `lazyOAuth`-shaped object
   whose `load` sets a flag, pass it through `resolveOauth`, call `oauthVendors()`, and
   assert the flag is still `false`.

   A synchronous return alone does **not** prove no dynamic import was _initiated_ — a sync
   function can call `import()` and drop the promise. The `load`-flag assertion is what
   actually proves it, and the synchronous signature only proves no import was _awaited_.
   Assert both; do not claim the first implies the second.

3. `it("labels each vendor with loginLabel when it has one and name otherwise")` — assert
   the full six-entry result deep-equals, by value:

   ```ts
   [
     {
       id: "anthropic",
       label: "Anthropic (Claude Pro/Max)",
       isSubscription: true,
     },
     { id: "github-copilot", label: "GitHub Copilot", isSubscription: true },
     {
       id: "kimi-coding",
       label: "Sign in with Kimi Code",
       isSubscription: true,
     },
     {
       id: "openai-codex",
       label: "OpenAI (ChatGPT Plus/Pro)",
       isSubscription: true,
     },
     {
       id: "openrouter",
       label: "Sign in with OpenRouter",
       isSubscription: false,
     },
     {
       id: "xai",
       label: "Sign in with SuperGrok or X Premium",
       isSubscription: true,
     },
   ];
   ```

   `anthropic`, `github-copilot` and `openai-codex` set no `loginLabel`, so their label is
   the `oauth.name`. `openrouter` sets no `isSubscription`, so it normalizes to `false`.
   `radius` is absent by the intersection rule, and its `oauth.name` would have been
   `"Radius"` had it been admitted.

4. `it("excludes a provider with no oauth")` — assert `openai` and `groq` are absent, and
   assert `openai-compatible` is absent (it has no `builtinProviders()` entry at all).

**Method-rule tests (pure, no library):**

5. `it("prefers the underscore device spelling")` — `chooseOptionId("openai-codex", ["browser","device_code"])` is `"device_code"`.
6. `it("prefers the hyphen device spelling")` — `chooseOptionId("radius", ["browser","device-code"])` is `"device-code"`.
7. `it("falls back to the browser option")` — `chooseOptionId("x", ["browser"])` is `"browser"`.
8. `it("refuses an option set with no recognized spelling")` — `chooseOptionId("x", ["qr","sms"])` throws `LoginError` with `refusal === "login-method-unavailable"` and `detail === "qr,sms"`.
9. `it("prefers device over browser regardless of order")` — `["device_code","browser"]` and `["browser","device_code"]` both answer `"device_code"`.

**Library-pinning tests for the select prompts.** These call `login()` on the real wrapper
with a recording interaction that throws a sentinel from `prompt`, so the flow aborts at
its first interaction and performs **zero network calls**. Verified: for these three
vendors the first interaction precedes any `fetch`.

10. `it("pins the openai-codex select option ids against the installed library")`:

    ```ts
    class Stop extends Error {}
    const provider = builtinProviders().find((p) => p.id === "openai-codex");
    let seen: AuthPrompt | undefined;
    await assert.rejects(
      () =>
        provider!.auth.oauth!.login({
          signal: new AbortController().signal,
          prompt: async (p) => {
            seen = p;
            throw new Stop();
          },
          notify: () => {},
        }),
      (error: unknown) => error instanceof Stop,
    );
    assert.equal(seen?.type, "select");
    assert.equal(seen?.message, "Select OpenAI Codex login method:");
    assert.deepEqual(
      (seen as { options: readonly { id: string }[] }).options.map((o) => o.id),
      ["browser", "device_code"],
    );
    assert.equal(
      chooseOptionId("openai-codex", ["browser", "device_code"]),
      "device_code",
    );
    ```

11. `it("pins the radius select option ids against the installed library")` — the same
    shape; assert `message === "Sign in to Radius:"` and the ids deep-equal
    `["browser", "device-code"]`, then `chooseOptionId` answers `"device-code"`.
12. `it("pins the github-copilot enterprise prompt message against the installed library")` —
    the same shape; assert `seen.type === "text"` and
    `seen.message === "GitHub Enterprise URL/domain (blank for github.com)"`.

13. `it("pins kimi-coding as a promptless device-code flow")` and
14. `it("pins xai as a promptless device-code flow")` — these two issue an HTTP request as
    their first act and prompt nothing, so stub the network rather than skipping them:

    ```ts
    const realFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = realFetch;
    });
    globalThis.fetch = (async () => {
      throw new Error("NETWORK-BLOCKED");
    }) as typeof fetch;
    ```

    Call `login()` with a recording interaction and assert the recorded `prompt` count is
    `0` and that the rejection carries the stub's own message. That pins the property the
    adapter relies on — neither vendor offers an answerable prompt — with no network and no
    socket. Restore `fetch` in `t.after` unconditionally, and take `(t)` as the test
    argument so the hook is scoped.

Do **not** write an equivalent test for `anthropic` or `openrouter`. Both bind a real
loopback callback port before their first `notify`, and no `fetch` stub prevents a `net`
listen, so either test would open a socket and break the hermetic rule. See **S4** in the
index.

## Constraints

- `oauthVendors()` is synchronous and reads only `name`, `isSubscription`, `loginLabel`.
  It never calls `login`, `refresh` or `toAuth`.
- The admitted set is derived. Never write a literal vendor array in `src/`. The literal
  in the test is the pin, and it is the only literal.
- `chooseOptionId` throws `LoginError`, never returns a fallback.
- Import `OAuthAuth` from `"@earendil-works/pi-ai"`, and `builtinProviders` **and
  `getBuiltinProviders`** from `"@earendil-works/pi-ai/providers/all"` — the latter is
  already imported by `src/services/model-catalog/pi-ai.ts:2-5`, so the specifier is
  established. Never from `"@earendil-works/pi-ai/oauth"` and never by a `dist/` path.
- Tests 10-12 must assert the sentinel rejection, so a flow that starts reaching the
  network fails loudly instead of hanging.

## Verify

```
node --test src/services/provider-auth/pi-ai.test.ts
npm run verify
```

Asserts: the six-id admitted set derived from the library and cross-checked against an
independent derivation, the full label/subscription table by value, the four
`chooseOptionId` outcomes including the exact `detail` string, and the three prompt
literals pinned against the installed library with zero network calls.

Proof: delivers `src/services/provider-auth/pi-ai.test.ts` (PASS EPIC-045).
`npm run verify` exits 0.
