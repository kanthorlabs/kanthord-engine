# Story 2 — The startup refusal

Epic: `.agent/plan/epics/010.5-browser-access.md`
Depends on: Story 1 (`http.allowedOrigins` must exist in the schema and in `HttpSettings`).

## Change

### 1. `src/services/config/refusals.ts:6-12` — widen the input

`StartableInput` gains `allowedOrigins`, after `token`:

```ts
export type StartableInput = Readonly<{
  masterKey: string;
  masterKeyFile: string;
  masterKeyFileMode: number | undefined;
  bind: string;
  token: string;
  allowedOrigins: readonly string[];
}>;
```

### 2. `src/services/config/refusals.ts:47-52` — add rule 5

Append after the existing non-loopback-bind rule, as the last statement of
`assertStartable`. It must be **after** rule 4, because `refusals.test.ts:149-170` pins that
rule precedence is fixed and reported by first match.

```ts
if (input.allowedOrigins.length > 0 && input.token.length === 0) {
  throw new ConfigError(
    "config-refused",
    "a non-empty http.allowedOrigins requires http.token",
  );
}
```

The message names `http.token`, which the EPIC gate requires.

This rule does not consult `bind`. A loopback bind with a configured origin still refuses,
because a browser page reaches a loopback daemon.

### 3. `src/services/config/convict.ts:216-222` — pass the field

The single production call site gains one property:

```ts
      allowedOrigins: config.get("http.allowedOrigins") as string[],
```

`assertStartable` runs after `config.validate` and after Story 1's canonicalization, so the
value it reads is already canonical.

## Constraints

- Do not reorder rules 1 through 4. `refusals.test.ts:149-170` asserts that an input failing
  rules 1 and 4 reports rule 1; the same first-match precedence now extends to rule 5.
- `assertStartable` has exactly one production call site (`convict.ts:216-222`). Do not add
  another.
- Every existing `validInput` construction in `refusals.test.ts:8-17` must gain
  `allowedOrigins: []` so the current suite keeps its meaning: today's inputs configure no
  origin and must stay startable.

## Verify

`node --test src/services/config/refusals.test.ts` — extend. Assert through the file's
convention: `assert.throws` with a predicate asserting `err instanceof ConfigError`, exact
`err.code`, and **exact `err.message` string equality**.

- `validInput({ allowedOrigins: ["http://localhost:8080"], token: "" })` throws
  `config-refused` with message exactly
  `a non-empty http.allowedOrigins requires http.token`.
- `validInput({ allowedOrigins: ["http://localhost:8080"], token: "t" })` returns
  `undefined`.
- `validInput({ allowedOrigins: [], token: "" })` returns `undefined` — an empty list with
  no token stays startable on a loopback bind.
- Rule 5 fires on a loopback bind: `bind: "127.0.0.1"` with a non-empty origin list and an
  empty token throws.
- Rule precedence: an input failing rule 4 and rule 5 together (`bind: "0.0.0.0"`,
  `token: ""`, `allowedOrigins: ["http://a.test"]`) reports rule 4 — message exactly
  `a non-loopback bind address requires http.token`.
- Every pre-existing test in the file still passes unchanged in meaning.

`node --test src/services/config/convict.test.ts` — extend. Prove the wiring through the
full load path, mirroring the existing `config-refused` block at `convict.test.ts:683-730`:

- A config file with `http.allowedOrigins: ["http://localhost:8080"]` and `http.token: ""`
  fails to load with `err.code` `config-refused` and the message naming `http.token`.
- The same file with `http.token: "my-token"` loads, and
  `result.settings.http.allowedOrigins` equals `["http://localhost:8080"]`.

`npm run verify` exits 0.

Proof: delivers the `src/services/config/refusals.test.ts` leg of the EPIC Proof line, and
the gate item "a non-empty origin list with an empty token refuses startup and the message
names `http.token`".
