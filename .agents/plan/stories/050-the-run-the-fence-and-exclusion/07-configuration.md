# Story 7 — Configuration

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: nothing in this epic. EPIC 050.1 Story 3 consumes both settings, and EPIC 050.2 Story 3 consumes `runMaxLifetimeMs` again.
Kind: story-foundation

## Change

Two settings, `runTtlMs` defaulting to `300000` and `runMaxLifetimeMs` defaulting to `14400000`. Follow the `attemptLimit` template at `src/services/config/convict.ts:231-235` exactly — it is the top-level integer shape.

**1 — `src/services/config/index.ts`.** Add two members to `Settings` at `src/services/config/index.ts:28-36`, after `leaseTtlMs` at `:35`:

```ts
runTtlMs: number;
runMaxLifetimeMs: number;
```

The key order in the type is the key order the projection must produce, and `src/services/config/convict.test.ts:104-121` asserts it.

**2 — `src/services/config/convict.ts` — the schema.** Add two entries after the `leaseTtlMs` entry at `:236-240`:

```ts
runTtlMs: {
  format: "runTtlMs",
  default: 300000,
  env: "KANTHORD_RUN_TTL_MS",
},
runMaxLifetimeMs: {
  format: "positiveInteger",
  default: 14400000,
  env: "KANTHORD_RUN_MAX_LIFETIME_MS",
},
```

**3 — the `runTtlMs` format.** `positiveInteger` at `src/services/config/convict.ts:44-48` admits `1`, and the EPIC refuses a `runTtlMs` below `1000`. Add one validator beside it:

```ts
function runTtlMilliseconds(value: unknown): void {
  if (!Number.isInteger(value) || (value as number) < 1000) {
    throw new Error("must be an integer >= 1000");
  }
}
```

and register it in the `convict.addFormats` call at `src/services/config/convict.ts:334-341` as `runTtlMs: { validate: runTtlMilliseconds }`. A non-integer and a value below `1000` both fail here, and both surface as `config-invalid`.

**4 — the env-integer table.** Add two rows to the array at `src/services/config/convict.ts:346-357`:

```ts
["KANTHORD_RUN_TTL_MS", "runTtlMs"],
["KANTHORD_RUN_MAX_LIFETIME_MS", "runMaxLifetimeMs"],
```

Without a row here convict leaves the env value a string and the format refuses it. `parseEnvInteger` at `:56-61` returns `NaN` for a non-numeric string, which the format then refuses.

**5 — the projection.** Add two reads to `src/services/config/convict.ts:490-523`, after `leaseTtlMs` at `:517`:

```ts
runTtlMs: config.get("runTtlMs") as number,
runMaxLifetimeMs: config.get("runMaxLifetimeMs") as number,
```

**6 — the cross-field refusal.** `runMaxLifetimeMs` below `runTtlMs` is a legal-but-unstartable combination of two valid values, which is what `config-refused` is for. A convict format cannot see a second field. Add the rule to `assertStartable` in `src/services/config/refusals.ts`, following the shape at `src/services/config/refusals.ts:96-98`: add `runTtlMs: number` and `runMaxLifetimeMs: number` to its input record at `:21`, and

```ts
if (input.runMaxLifetimeMs < input.runTtlMs) {
  throw new ConfigError("config-refused", runMaxLifetimeBelowTtl);
}
```

with `runMaxLifetimeBelowTtl` declared as a message const beside the file's other message consts. Thread the two values in at the `assertStartable` call site, `src/services/config/convict.ts:427-439`.

**7 — the consumers.** `src/main.ts` passes `settings.runTtlMs` and `settings.runMaxLifetimeMs` into the claim of EPIC 050.1 Story 3, beside the existing `leaseTtlMs`. EPIC 050.2 Story 3 adds the renew as the second consumer.

## Constraints

- `runTtlMs` refuses below `1000` and refuses a non-integer, as `config-invalid`.
- `runMaxLifetimeMs` below `runTtlMs` refuses as `config-refused`, not `config-invalid`. The two codes mean different things: a bad value against a legal-but-unstartable combination.
- Do not change `leaseTtlMs` or `attemptLimit`.
- The `Settings` key order is `home, actor, masterKey, http, tools, attemptLimit, leaseTtlMs, runTtlMs, runMaxLifetimeMs`.

## Verify

```
node --test src/services/config/convict.test.ts src/services/config/refusals.test.ts
```

The EPIC's Proof block names `src/services/config/config.test.ts`. That file does not exist; the loader's test file is `src/services/config/convict.test.ts`, and the startup-refusal tests live in `src/services/config/refusals.test.ts`. Write the cases into those two files and update the Proof line to name them.

Add to `src/services/config/convict.test.ts`, following the `attemptLimit` block at `:386-444` and the table-driven block at `:1775-1811`:

1. `"defaults runTtlMs to 300000 when omitted"` — delete the key from a `validFile()` and assert `result.settings.runTtlMs === 300000`.

2. `"defaults runMaxLifetimeMs to 14400000 when omitted"` — assert by value.

3. `"loads runTtlMs: 1000"` — the exact lower bound is accepted.

4. A table-driven refusal block over `[["runTtlMs", 999], ["runTtlMs", 0], ["runTtlMs", -1], ["runTtlMs", 1500.5], ["runTtlMs", "300000"], ["runMaxLifetimeMs", 0], ["runMaxLifetimeMs", -1], ["runMaxLifetimeMs", 1.5]]`, each asserting `err.code === "config-invalid"`. Each value is asserted by value, per the EPIC's gate.

5. `"KANTHORD_RUN_TTL_MS=600000 wins over the file value"` — mirror `:497-511`.

6. `"KANTHORD_RUN_MAX_LIFETIME_MS=7200000 wins over the file value"`.

7. `"KANTHORD_RUN_TTL_MS=abc throws config-invalid"` — proves the `parseEnvInteger` `NaN` path reaches the format.

8. `"an unknown key runTtlMillis throws config-invalid"` — proves `allowed: "strict"` still covers the new names.

9. Update the key-order case at `src/services/config/convict.test.ts:104-121` to the nine-element list ending `"runTtlMs", "runMaxLifetimeMs"`.

Add to `src/services/config/refusals.test.ts`:

10. `"runMaxLifetimeMs below runTtlMs throws config-refused"` — `runTtlMs: 300000`, `runMaxLifetimeMs: 299999`. Assert `err.code === "config-refused"`.

11. `"runMaxLifetimeMs equal to runTtlMs starts"` — `300000` and `300000`. Assert no throw. The boundary is legal, because the EPIC refuses "below `runTtlMs`" and not "at".

12. `"the defaults start"` — `300000` and `14400000`. Assert no throw.

`pnpm run verify` exits 0.

Proof: PASS line delivered — the EPIC's `src/services/config/config.test.ts` line, redirected to `src/services/config/convict.test.ts` and `src/services/config/refusals.test.ts` in `PASS EPIC-050`.
