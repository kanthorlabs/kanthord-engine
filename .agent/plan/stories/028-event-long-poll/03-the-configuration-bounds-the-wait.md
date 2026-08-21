# Story 3 — The configuration bounds the wait

Epic: `.agent/plan/epics/028-event-long-poll.md`

## Change

### `src/services/config/index.ts`

Add one type immediately after `HttpIdempotencySettings` (lines 1-6):

```ts
export type HttpEventSettings = Readonly<{
  maxWait: number;
}>;
```

Add one member to `HttpSettings`, as the **last** member after `idempotency` at line 14:

```ts
event: HttpEventSettings;
```

### `src/services/config/convict.ts`

In the `http` schema block, add an `event` block immediately after the `idempotency` block closes. The `idempotency` members are at lines 184-204 (`ttl`, `joinTimeout`, `maxEntries`, `maxBytes`). Mirror the `joinTimeout` entry at lines 190-194 exactly:

```ts
        event: {
          maxWait: {
            format: "nonNegativeInteger",
            default: 30,
            env: "KANTHORD_HTTP_EVENT_MAX_WAIT",
          },
        },
```

`nonNegativeInteger`, so `0` is valid and disables the wait daemon-wide.

In the env-integer list at lines 339-349, add one entry as the **last** entry, after the `KANTHORD_LEASE_TTL_MS` pair:

```ts
      ["KANTHORD_HTTP_EVENT_MAX_WAIT", "http.event.maxWait"],
```

In the settings projection at lines 491-499, add one member immediately after the `idempotency` object closes at line 498:

```ts
          event: {
            maxWait: config.get("http.event.maxWait") as number,
          },
```

Change nothing else. Add no new convict format — `nonNegativeInteger` already exists.

## Constraints

- The default is `30`, not `60`. The schema ceiling of Story 2 is `60` and the daemon default is `30`; they are two different numbers and both are correct.
- Add no upper bound in convict. The refusal against the configured maximum is the handler's, in Story 5.
- Write no configuration-file sample. No generated sample is asserted anywhere in the repository.
- Do not rename or reorder any existing configuration key.

## Verify

### `src/services/config/convict.test.ts`

Use the existing file helpers and add no new one: `tmpDir()` (lines 11-19), `validFile(overrides)` (lines 21-38), `writeJson(dir, object)` and `loadInput(dir, filePath, overrides)` (lines 40-53). Every test opens `tmpDir()`, wraps the body in `try`, and calls `fs.rmSync(dir, { recursive: true })` in `finally`.

Mirror the two `http.idempotency` templates: the defaults test at lines 1680-1695 and the env-override test at lines 1869-1882.

Add these tests:

- A configuration file from `validFile()` with no `http.event` key gives `result.settings.http.event` deep-equal to `{ maxWait: 30 }`.
- `env: { KANTHORD_HTTP_EVENT_MAX_WAIT: "45" }` gives `result.settings.http.event.maxWait` equal to `45` — the number `45`, not the string. This proves the entry reached `idempotencyEnvIntegers`.
- `env: { KANTHORD_HTTP_EVENT_MAX_WAIT: "0" }` gives `0`, and the load does not throw.
- A configuration file naming `http: { ...validFile().http, event: { maxWait: 10 } }` gives `10`.
- A configuration file naming `event: { maxWait: -1 }` throws. Assert the throw and the `config-invalid` code, matching the refusals loop at lines 1775-1811. Do not assert the message text.
- A configuration file naming `event: { maxWait: 1.5 }` throws `config-invalid`.
- `env: { KANTHORD_HTTP_EVENT_MAX_WAIT: "abc" }` throws. Assert the throw only.
- The env var wins over the file: a file naming `event: { maxWait: 10 }` loaded with `env: { KANTHORD_HTTP_EVENT_MAX_WAIT: "45" }` gives `45`.
- An unknown key `http: { event: { sweepInterval: 1 } }` throws `config-invalid`, proving strict mode for the new block. Mirror the test at line 1813.

Leave the top-level key-order test at lines 104-121 byte-identical. `event` nests under `http`, so that list does not change.

### `src/cli/config/generate.ts` and `src/cli/config/generate.test.ts`

No edit. The generated configuration file at `generate.ts:81-95` carries no `idempotency` block either, so it carries no `event` block. `maxWait` comes from the schema default.

### Commands

```bash
node --test src/services/config/convict.test.ts
```

`npm run verify` exits 0. `npm run typecheck` must be clean — adding `event` to `HttpSettings` makes every construction site of that type incomplete, and `src/services/config/convict.ts` is the only one in production. If typecheck names a test fixture that builds an `HttpSettings` literal, add `event: { maxWait: 30 }` to it and change nothing else in that fixture.

Proof: `PASS EPIC-028` for `src/services/config/convict.test.ts`.
