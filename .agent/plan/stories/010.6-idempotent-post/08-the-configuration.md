# Story 8 — The configuration

Epic: `.agent/plan/epics/010.6-idempotent-post.md`
Depends on: Story 4, Story 5.

## Change

### 1. `src/services/config/index.ts` — the settings type

Add above `HttpSettings` (`index.ts:1-6`):

```ts
export type HttpIdempotencySettings = Readonly<{
  ttl: number;
  joinTimeout: number;
  maxEntries: number;
  maxBytes: number;
}>;
```

Add one member to `HttpSettings`, after `allowedHosts`:

```ts
idempotency: HttpIdempotencySettings;
```

`ttl` and `joinTimeout` are in **seconds**. The transport type `IdempotencySettings`
(`src/http/server/idempotency-store.ts`) names them `ttlSeconds` and `joinTimeoutSeconds`. The two
are distinct types on purpose: `src/http/server/` may not import a service, so `main.ts` maps one to
the other.

### 2. `src/services/config/convict.ts` — the format

Add a validator after `positiveInteger` (`convict.ts:28-32`):

```ts
function nonNegativeInteger(value: unknown): void {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("must be a non-negative integer >= 0");
  }
}
```

`ttl` needs it because `0` is a legal configuration: it disables the memory policy. `joinTimeout`
needs it because `0` gives the join the lifetime of the original. `maxEntries` and `maxBytes` keep
the existing `positiveInteger`, because a zero bound would make every keyed request saturated.

Register it in the `convict.addFormats({ ... })` call at `convict.ts:169-174`, as
`nonNegativeInteger,` beside `positiveInteger`.

### 3. `src/services/config/convict.ts` — the schema

Add to the `http` group in `buildSchema()` (`convict.ts:53-66`), **after** `allowedHosts` and
before the closing brace of `http`:

```ts
      idempotency: {
        ttl: {
          format: "nonNegativeInteger",
          default: 300,
          env: "KANTHORD_HTTP_IDEMPOTENCY_TTL",
        },
        joinTimeout: {
          format: "nonNegativeInteger",
          default: 30,
          env: "KANTHORD_HTTP_IDEMPOTENCY_JOIN_TIMEOUT",
        },
        maxEntries: {
          format: "positiveInteger",
          default: 256,
          env: "KANTHORD_HTTP_IDEMPOTENCY_MAX_ENTRIES",
        },
        maxBytes: {
          format: "positiveInteger",
          default: 8388608,
          env: "KANTHORD_HTTP_IDEMPOTENCY_MAX_BYTES",
        },
      },
```

Every one has a default, so an existing config file that omits the whole `idempotency` group loads
unchanged. `config.validate({ allowed: "strict" })` (`convict.ts:187`) refuses an _unknown_ key, not
an omitted one.

Do not add a `doc` key. No property in this schema has one.

### 4. `src/services/config/convict.ts` — the returned settings

In the returned object at `convict.ts:239-261`, add to the `http` literal, after `allowedHosts`:

```ts
        idempotency: {
          ttl: config.get("http.idempotency.ttl") as number,
          joinTimeout: config.get("http.idempotency.joinTimeout") as number,
          maxEntries: config.get("http.idempotency.maxEntries") as number,
          maxBytes: config.get("http.idempotency.maxBytes") as number,
        },
```

The top-level `Settings` key order is asserted at `convict.test.ts:107`; it is unchanged. The `http`
sub-key order is not asserted, so appending is safe.

No normalization step and no canonicalization step is added. All four values are integers that
convict validates directly.

### 5. `src/main.ts:277-288` — the mapping

Add two members to the `createApp` argument, after `unimplemented`:

```ts
          idempotency: {
            ttlSeconds: settings.http.idempotency.ttl,
            joinTimeoutSeconds: settings.http.idempotency.joinTimeout,
            maxEntries: settings.http.idempotency.maxEntries,
            maxBytes: settings.http.idempotency.maxBytes,
          },
          now: () => clock.now(),
```

`clock` is the single daemon `SystemClock` constructed at `src/main.ts:138`. Passing
`() => clock.now()` rather than `Date.now` keeps the daemon on one clock and keeps
`src/http/server/` free of a service import.

Do **not** pass `schedule`. `createApp` defaults it to the unref'd `systemSchedule` of Story 4, and
the daemon has no second scheduler to offer.

## Constraints

- Do not add `coerce` to any format. `src/services/config/convict.d.ts:21-24` types `addFormats` as
  accepting `{ validate }` only, and widening it is out of scope.
- Do not touch `positiveInteger`, `hostList`, `nonEmptyString` or `absolutePath`.
- Do not touch `assertStartable` (`src/services/config/refusals.ts`). No idempotency value refuses
  startup, and `src/services/config/refusals.test.ts:149-170` pins the existing rule order.
- Do not change the top-level `Settings` key order.
- `src/main.ts` is the only production file that reads `settings.http.idempotency`.

## Verify

`node --test src/services/config/convict.test.ts` — extend. Follow the file's conventions exactly:
a `tmpDir()` per test with a `finally` cleanup, `validFile(overrides)` for the file body,
`loadInput(dir, filePath, { env })` for env injection, never `process.env`, and a refusal asserted
through `assert.throws` with a predicate checking `err.code`.

Defaults:

- A config file that omits `http.idempotency` loads, and `result.settings.http.idempotency`
  deep-equals `{ ttl: 300, joinTimeout: 30, maxEntries: 256, maxBytes: 8388608 }`.
- A config file with `http.idempotency: {}` loads and yields the same four defaults.
- A config file with `http.idempotency: { ttl: 60 }` yields
  `{ ttl: 60, joinTimeout: 30, maxEntries: 256, maxBytes: 8388608 }` — a partial group keeps the
  other defaults.

Accepted values:

- `ttl: 0` loads and yields `0`.
- `joinTimeout: 0` loads and yields `0`.
- `joinTimeout: 1` loads and yields `1`.
- `maxEntries: 1` loads and yields `1`.
- `maxBytes: 1` loads and yields `1`.

Refusals, each `err.code === "config-invalid"`:

- `ttl: -1`
- `ttl: 1.5`
- `ttl: "300"` — a string is not an integer.
- `joinTimeout: -1`
- `joinTimeout: 1.5`
- `maxEntries: 0`
- `maxEntries: -1`
- `maxEntries: 1.5`
- `maxBytes: 0`
- `maxBytes: 1.5`
- an unknown key `http.idempotency.sweepInterval: 1` — proves the group is under strict mode.

Env overrides, injected through `loadInput(dir, filePath, { env: { … } })`:

- `KANTHORD_HTTP_IDEMPOTENCY_TTL: "60"` yields `ttl === 60`.
- `KANTHORD_HTTP_IDEMPOTENCY_TTL: "0"` yields `ttl === 0`.
- `KANTHORD_HTTP_IDEMPOTENCY_JOIN_TIMEOUT: "5"` yields `joinTimeout === 5`.
- `KANTHORD_HTTP_IDEMPOTENCY_JOIN_TIMEOUT: "0"` yields `joinTimeout === 0`.
- `KANTHORD_HTTP_IDEMPOTENCY_MAX_ENTRIES: "10"` yields `maxEntries === 10`.
- `KANTHORD_HTTP_IDEMPOTENCY_MAX_BYTES: "1024"` yields `maxBytes === 1024`.
- `KANTHORD_HTTP_IDEMPOTENCY_TTL: "abc"` throws `config-invalid`.
- An env value overrides a config-file value: file `ttl: 30` plus env `"90"` yields `90`.

Unchanged:

- The `Settings` key order test at `convict.test.ts:107` passes with no edit.
- Every existing test in the file passes with no edit.

`node --test src/services/config/refusals.test.ts` — passes unchanged.

`node --test src/http/server/idempotency.test.ts src/http/server/idempotency-store.test.ts` —
pass unchanged. This story changes no transport behaviour; it only sources the numbers.

`npm run verify` exits 0. The typecheck is the gate on step 5: adding a required member to
`HttpSettings` breaks any construction of it, and `src/main.ts:105-112` is the only production
construction. Test fixtures build a config **file**, not a `HttpSettings` literal, so they need no
edit.

Proof: no Proof line of its own. It sources `ttlSeconds`, `joinTimeoutSeconds`, `maxEntries` and `maxBytes` from
configuration for the behaviour Stories 4 and 5 already prove.
