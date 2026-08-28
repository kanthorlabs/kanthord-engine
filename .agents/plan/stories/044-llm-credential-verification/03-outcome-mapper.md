# Story 3 — Outcome mapper with comprehensive tests

Epic: `.agents/plan/epics/044-llm-credential-verification.md`
Depends on: Story 1 (types from index.ts)

## Dispatch note

This story is implemented BEFORE Story 2. The probe in Story 2 imports `toVerdict`
from `./verdict.ts`. Create and verify this story first.

## Change

### `src/services/provider-auth/verdict.ts` (new file)

```ts
import type { ProbeOutcome, VerifyRefusal } from "./index.ts";

export type RawOutcome =
  | { kind: "success" }
  | { kind: "abort" }
  | { kind: "http-auth"; status: number }
  | { kind: "http-not-found"; status: number }
  | { kind: "http-quota"; status: number }
  | { kind: "http-other"; status: number }
  | { kind: "transport-error" };

type VerdictWithoutModel = Omit<ProbeOutcome, "model">;

export function toVerdict(raw: RawOutcome): VerdictWithoutModel {
  switch (raw.kind) {
    case "success":
      return {
        reachability: "reachable",
        authentication: "accepted",
        completed: true,
        refusal: null,
      };
    case "abort":
      return {
        reachability: "unreachable",
        authentication: "unknown",
        completed: false,
        refusal: "endpoint-unreachable",
        detail: "timeout-or-abort",
      };
    case "http-auth":
      return {
        reachability: "reachable",
        authentication: "rejected",
        completed: false,
        refusal: "credential-rejected",
        detail: `HTTP ${raw.status}`,
      };
    case "http-not-found":
      return {
        reachability: "reachable",
        authentication: "accepted",
        completed: false,
        refusal: "model-unavailable",
        detail: `HTTP ${raw.status}`,
      };
    case "http-quota":
      return {
        reachability: "reachable",
        authentication: "accepted",
        completed: false,
        refusal: "quota-exceeded",
        detail: `HTTP ${raw.status}`,
      };
    case "http-other":
      return {
        reachability: "reachable",
        authentication: "unknown",
        completed: false,
        refusal: "endpoint-rejected",
        detail: `HTTP ${raw.status}`,
      };
    case "transport-error":
      return {
        reachability: "unreachable",
        authentication: "unknown",
        completed: false,
        refusal: "endpoint-unreachable",
        detail: "transport-error",
      };
  }
}
```

### `src/services/provider-auth/verdict.test.ts` (new file)

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toVerdict } from "./verdict.ts";
```

Eight test cases, each using `assert.deepEqual` on the full returned object
(which excludes `model`):

1. `toVerdict({ kind: "success" })`:

   ```ts
   const result = toVerdict({ kind: "success" });
   assert.deepEqual(result, {
     reachability: "reachable",
     authentication: "accepted",
     completed: true,
     refusal: null,
   });
   assert.equal("detail" in result, false);
   ```

2. `toVerdict({ kind: "abort" })`:

   ```ts
   assert.deepEqual(toVerdict({ kind: "abort" }), {
     reachability: "unreachable",
     authentication: "unknown",
     completed: false,
     refusal: "endpoint-unreachable",
     detail: "timeout-or-abort",
   });
   ```

3. `toVerdict({ kind: "http-auth", status: 401 })`:

   ```ts
   assert.deepEqual(toVerdict({ kind: "http-auth", status: 401 }), {
     reachability: "reachable",
     authentication: "rejected",
     completed: false,
     refusal: "credential-rejected",
     detail: "HTTP 401",
   });
   ```

4. `toVerdict({ kind: "http-auth", status: 403 })`:

   ```ts
   assert.deepEqual(toVerdict({ kind: "http-auth", status: 403 }), {
     reachability: "reachable",
     authentication: "rejected",
     completed: false,
     refusal: "credential-rejected",
     detail: "HTTP 403",
   });
   ```

5. `toVerdict({ kind: "http-not-found", status: 404 })`:

   ```ts
   assert.deepEqual(toVerdict({ kind: "http-not-found", status: 404 }), {
     reachability: "reachable",
     authentication: "accepted",
     completed: false,
     refusal: "model-unavailable",
     detail: "HTTP 404",
   });
   ```

6. `toVerdict({ kind: "http-quota", status: 429 })`:

   ```ts
   assert.deepEqual(toVerdict({ kind: "http-quota", status: 429 }), {
     reachability: "reachable",
     authentication: "accepted",
     completed: false,
     refusal: "quota-exceeded",
     detail: "HTTP 429",
   });
   ```

7. `toVerdict({ kind: "http-other", status: 500 })`:

   ```ts
   assert.deepEqual(toVerdict({ kind: "http-other", status: 500 }), {
     reachability: "reachable",
     authentication: "unknown",
     completed: false,
     refusal: "endpoint-rejected",
     detail: "HTTP 500",
   });
   ```

8. `toVerdict({ kind: "transport-error" })`:
   ```ts
   assert.deepEqual(toVerdict({ kind: "transport-error" }), {
     reachability: "unreachable",
     authentication: "unknown",
     completed: false,
     refusal: "endpoint-unreachable",
     detail: "transport-error",
   });
   ```

## Constraints

- `verdict.ts` imports only from `./index.ts`. No `@earendil-works/pi-ai` import.
- The return type is `Omit<ProbeOutcome, "model">` — `model` is set by the probe.
- For the `"success"` case, `detail` is absent (not `undefined`). The `switch` branch
  returns an object literal without a `detail` key.
- Each `assert.deepEqual` compares the entire returned object. The `"detail" in result`
  check additionally verifies key absence for the success case.

## Verify

```
node --test src/services/provider-auth/verdict.test.ts
npm run lint -- --quiet
```

Proof: delivers `src/services/provider-auth/verdict.test.ts` (PASS EPIC-044).
