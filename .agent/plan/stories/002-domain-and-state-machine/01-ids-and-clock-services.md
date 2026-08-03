# Story 01 — `services/ids` and `services/clock`

Epic: `.agent/plan/epics/002-domain-and-state-machine.md`
Depends on: Story 02 (`src/domain/identity.ts` supplies `IdentityKind`).

## Change

### 1. `src/services/ids/index.ts` (new)

```ts
import type { IdentityKind } from "../../domain/identity.ts";

export type IdGeneratorErrorCode = "ids-exhausted";

export class IdGeneratorError extends Error {
  readonly code: IdGeneratorErrorCode;

  constructor(code: IdGeneratorErrorCode, message: string) {
    super(message);
    this.name = "IdGeneratorError";
    this.code = code;
  }
}

export interface IdGenerator {
  mint(kind: IdentityKind): string;
}
```

### 2. `src/services/ids/ulid.ts` (new)

```ts
import { ulid } from "ulid";

import { identityPrefixes } from "../../domain/identity.ts";
import type { IdentityKind } from "../../domain/identity.ts";
import type { IdGenerator } from "./index.ts";

export class UlidIdGenerator implements IdGenerator {
  mint(kind: IdentityKind): string {
    return `${identityPrefixes[kind]}_${ulid()}`;
  }
}
```

### 3. `src/services/clock/index.ts` (new)

```ts
export interface Clock {
  now(): number;
}
```

`now()` returns epoch milliseconds as an integer. `docs/proposal/database/README.md:42` fixes that unit.

### 4. `src/services/clock/system.ts` (new)

```ts
import type { Clock } from "./index.ts";

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
```

### 5. `test/helpers/ids.ts` (new)

```ts
import type { IdGenerator } from "../../src/services/ids/index.ts";
import { IdGeneratorError } from "../../src/services/ids/index.ts";
import { identityPrefixes } from "../../src/domain/identity.ts";
import type { IdentityKind } from "../../src/domain/identity.ts";

export type MockIdGeneratorInput = Readonly<{ ulids: readonly string[] }>;

export function createMockIdGenerator(input: MockIdGeneratorInput): IdGenerator;
```

Behaviour, exact:

- `mint(kind)` returns `` `${identityPrefixes[kind]}_${input.ulids[n]}` `` where `n` is the count of previous `mint` calls, whatever the kind.
- The `n+1`-th call past the end throws `IdGeneratorError` with code `ids-exhausted` and message `` `mock id generator exhausted after ${input.ulids.length} ids` ``.

### 6. `test/helpers/clock.ts` (new)

```ts
import type { Clock } from "../../src/services/clock/index.ts";

export type MockClockInput = Readonly<{ start: number; step?: number }>;

export function createMockClock(input: MockClockInput): Clock;
```

Behaviour, exact: the `n`-th `now()` call (`n` from `0`) returns `input.start + n * (input.step ?? 0)`.

### 7. `eslint.config.js` — ban `ulid` inside `src/domain/**`

At `eslint.config.js:172-189`, the block for files `src/domain/**/*.ts` bans `node:*` plus every entry of `vendorPackages` (`eslint.config.js:7-16`). `ulid` is in neither list today, so `src/domain/` may import it.

Add `"ulid"` to the banned `patterns` group of that `src/domain/**/*.ts` block only. Do **not** add `ulid` to `vendorPackages` — `src/services/ids/ulid.ts` and `src/main.ts:5` import it legally.

Keep the existing message string `"domain/ is pure: domain/ and zod only."` unchanged.

## Constraints

- `src/domain/` gains no import from this story. The generator and the clock live in `src/services/`.
- `src/main.ts:5` already imports `ulid` and `src/main.ts:46` calls it for `instanceId`. Leave both untouched — `src/main.ts` is the composition root and is outside the `src/domain/**` glob.
- `test/helpers/*.ts` files import production modules through relative paths (`test/helpers/daemon.ts` is the precedent). The relaxation block at `eslint.config.js:259-281` allows it.
- No file in this story reads `Date.now()` except `src/services/clock/system.ts`.

## Verify

`node --test src/services/ids/ulid.test.ts` — new file, one suite named `"src/services/ids/ulid.test"`:

- `mint("project")` returns a string matching `/^project_[0-7][0-9A-HJKMNP-TV-Z]{25}$/`.
- `parseIdentity(generator.mint(kind))?.kind` equals `kind` for every one of the 17 members of `identityKinds`, driven by a `for (const kind of identityKinds)` loop. That covers the three node prefixes.

Assert no ordering and no uniqueness here. `ulid()` is not the monotonic factory, so two ids minted inside one millisecond carry independent randomness and may sort in either direction. Ordering is a property of the timestamp field, not of two adjacent calls, and a test that asserts it is flaky. `test/helpers/ids.ts` is what makes an id assertable.

`node --test src/services/clock/system.test.ts` — new file, suite `"src/services/clock/system.test"`:

- `Number.isInteger(new SystemClock().now())` is `true`.

Assert no threshold and no monotonicity. Wall time is ambient, and `Date.now()` moves backward across a clock step. `test/helpers/clock.ts` is what makes a timestamp assertable.

`node --test test/helpers/ids.test.ts` — new file, suite `"test/helpers/ids.test"`:

- `createMockIdGenerator({ ulids: ["01HZY000000000000000000000"] }).mint("project")` equals `"project_01HZY000000000000000000000"` exactly.
- A generator built with two ulids returns them in order across two `mint` calls with two different kinds.
- The call past the end throws, and the thrown error has `code === "ids-exhausted"`.

`node --test test/helpers/clock.test.ts` — new file, suite `"test/helpers/clock.test"`:

- `createMockClock({ start: 1000 }).now()` called three times returns `1000`, `1000`, `1000`.
- `createMockClock({ start: 1000, step: 5 }).now()` called three times returns `1000`, `1005`, `1010`.

`node --test src/domain/layout.test.ts` — new file, suite `"src/domain/layout.test"`. This is the repository-structure guard, and Story 11 extends it with the service inventory. `src/domain/version.test.ts:1-13` is the precedent for a domain test that reads the repository with `node:fs`:

- For every `src/domain/*.ts` file that is not `*.test.ts`, read the source with `node:fs` and assert it contains neither `"Date.now("` nor `"new Date("` nor `"Math.random("`. The failure message names the offending file.
- Using `lintCase` from `test/helpers/lint.ts`, a case at `filePath: "src/domain/probe.ts"` with code `import { ulid } from "ulid";` returns a rule list containing `"no-restricted-imports"`.
- The same code at `filePath: "src/services/ids/ulid.ts"` returns a rule list that does **not** contain `"no-restricted-imports"`.
- The same code at `filePath: "src/main.ts"` returns a rule list that does **not** contain `"no-restricted-imports"`.

`npm run verify` exits 0.

Proof: contributes `src/domain/layout.test.ts` to `node --test src/domain/**/*.test.ts`; the rest of this story is covered by `npm run verify`.
