# Story 9 — `provider.catalog` reports the oauth capability

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`
Depends on: Story 4 (`oauthVendors()` and the verified label rule).

`CatalogProvider` gains exactly one member. Nothing else on it changes.

## Read this first: `radius` is not in the catalogue

Verified by running the installed library: `getBuiltinProviders()` returns **39** ids and
`builtinProviders()` returns **40** entries. The one difference is `radius`, and
`staticProviders()` iterates `getBuiltinProviders()`
(`src/services/model-catalog/pi-ai.ts:35`). So today `radius` is absent from
`provider.catalog` and `catalog.has("radius")` is `false`.

Two consequences, both of which break EPIC promises:

- The catalogue can never carry seven non-null `oauth` members. It carries six.
- Story 8's registration gate is `catalog.has(...)`, so a `radius` login can complete and
  then **never register**. `getBuiltinModels("radius")` also returns `[]`, so the model
  fallback of Story 7 is empty and `default-model-unknown` would refuse every `radius`
  registration even if the gate passed.

**This story asserts six, not seven, and does not add `radius` to the catalogue.** Adding it
changes the `provider.catalog` response for every existing consumer and still leaves a
vendor with zero models, so it is the human's decision — see blocker **B5** in the index.

## Change

### `src/services/model-catalog/index.ts`

Add the member type above `CatalogProvider` (`src/services/model-catalog/index.ts:32-38`)
and one field to the type itself:

```ts
export type CatalogOauth = Readonly<{ label: string }>;

export type CatalogProvider = Readonly<{
  id: string;
  name: string;
  baseUrl: string | null;
  requiresBaseUrl: boolean;
  oauth: CatalogOauth | null;
  models: readonly CatalogModel[];
}>;
```

`oauth` sits before `models` so the long model array stays last, matching the existing
field order habit. `null` means the vendor has no flow. The member carries `label` only:
the method and any needed prompt answer are discovered while `login()` runs, and nothing on
`OAuthAuth` exposes either.

### `src/services/model-catalog/pi-ai.ts`

`staticProviders()` (`src/services/model-catalog/pi-ai.ts:31-59`) already builds a `Map` of
`builtinProviders()` keyed by id at `:32-34`. Read `auth.oauth` from that same entry — no
second call to `builtinProviders()`, and no dependency on `provider-auth`:

```ts
const oauth = provider?.auth.oauth;
return {
  id,
  name: provider?.name ?? id,
  baseUrl: provider?.baseUrl ?? null,
  requiresBaseUrl: false,
  oauth: oauth === undefined ? null : { label: oauth.loginLabel ?? oauth.name },
  models: getBuiltinModels(id).map(…),
} satisfies CatalogProvider;
```

`loginLabel ?? name` is the rule, because `loginLabel` is optional on `OAuthAuth` and only
`kimi-coding`, `openrouter` and `xai` set it. Reading the three eager properties loads no
flow module (`dist/auth/helpers.js:44-47`).

Add `oauth: null` to the `openai-compatible` sentinel literal at
`src/services/model-catalog/pi-ai.ts:49-55`. It has no `builtinProviders()` entry and
therefore no flow.

Import `OAuthAuth` as a type from `"@earendil-works/pi-ai"` if the narrowing needs it.

### `src/queries/provider/read-catalog.ts`

No change. The query returns `catalog.providers()` verbatim
(`src/queries/provider/read-catalog.ts:22-28`), so the new member flows through with no
edit. Confirm by reading the file; do not add a mapping step.

### `test/helpers/model-catalog.ts`

`defaultCatalogProviders` (`test/helpers/model-catalog.ts:32-61`) must satisfy the widened
type. Add the member to all three entries:

- `anthropic` → `oauth: { label: "Anthropic (Claude Pro/Max)" }`
- `openai` → `oauth: null`
- `openai-compatible` → `oauth: null`

The `anthropic` value is the real library's `oauth.name` with no `loginLabel`, so the fake
mirrors the production truth.

### Tests

**`src/services/model-catalog/pi-ai.test.ts`.** Add to the `providers` describe
(`:15-84`), asserting against the real installed library:

1. `it("carries a non-null oauth member for every catalogued oauth vendor")` — assert the
   ids whose `oauth` is non-null deep-equal
   `["anthropic","github-copilot","kimi-coding","openai-codex","openrouter","xai"]`, in the
   catalogue's bytewise id order. **Six, not seven.**
   1b. `it("radius is absent from the catalogue")` — assert
   `catalog.providers().some((p) => p.id === "radius")` is `false` and
   `catalog.has("radius")` is `false`, and assert `getBuiltinProviders()` does not include
   `"radius"` while `builtinProviders()` does. This test pins the discrepancy so a library
   change that adds `radius` to the catalogue fails loudly instead of silently changing the
   response.
2. `it("carries a null oauth member for every other provider")` — assert `openai`, `groq`
   and `openai-compatible` all carry `null`. `openai-compatible` is asserted by name.
3. `it("labels a vendor with no loginLabel by its oauth name")` — assert `anthropic`'s
   label is exactly `"Anthropic (Claude Pro/Max)"`.
4. `it("labels a vendor with a loginLabel by that label")` — assert `xai`'s label is
   exactly `"Sign in with SuperGrok or X Premium"` and `openrouter`'s is
   `"Sign in with OpenRouter"`.
5. `it("reports only the label on the oauth member")` — assert
   `Object.keys(entry.oauth!)` deep-equals `["label"]`, so no method and no prompt leaks
   into the catalogue.
6. Extend the existing test at `:57` (`"carries only the closed model fields"`) with a
   sibling asserting the closed `CatalogProvider` key set is exactly
   `["id","name","baseUrl","requiresBaseUrl","oauth","models"]`.

**`src/queries/provider/read-catalog.test.ts`.** Add:

7. `it("passes the oauth member through unchanged")` — with `createFakeModelCatalog()`,
   assert the `anthropic` entry's `oauth` deep-equals
   `{ label: "Anthropic (Claude Pro/Max)" }` and the `openai-compatible` entry's is `null`.
8. Update the existing test at `:21`
   (`"marks openai-compatible as the one provider that needs a baseUrl"`) only if it
   deep-equals a whole provider object; if it does, add the `oauth` member to the expected
   literal.

## Constraints

- `CatalogProvider` gains exactly one member. `id`, `name`, `baseUrl`, `requiresBaseUrl`
  and `models` are untouched.
- The oauth member carries `label` and nothing else. No `method`, no `isSubscription`, no
  prompt list.
- `PiAiModelCatalog` reads `auth.oauth` from the `Map` it already builds. It calls
  `builtinProviders()` exactly once, as it does today.
- `services/model-catalog` does not import `services/provider-auth`. The two derive the
  same set independently from the library, and Story 4's test pins the set.
- `src/queries/provider/read-catalog.ts` is not edited.

## Verify

```
node --test \
  src/services/model-catalog/pi-ai.test.ts \
  src/queries/provider/read-catalog.test.ts
npm run verify
```

Asserts: the six-id non-null set, `radius`'s absence from both the catalogue and
`getBuiltinProviders()`, the null default against the installed library,
`openai-compatible` null by name, both label rules by exact string, the single-key oauth
member, and the closed `CatalogProvider` key set.

Proof: delivers `src/queries/provider/read-catalog.test.ts` (PASS EPIC-045).
`npm run verify` exits 0.
