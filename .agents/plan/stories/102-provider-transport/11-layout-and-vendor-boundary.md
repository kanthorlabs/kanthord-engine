# Story 11 — The layout and the vendor boundary

Epic: `.agents/plan/epics/102-provider-transport.md`
Depends on: Story 1.

## Change

- In `src/domain/layout.test.ts:108-124`, add `"model"` to the service-directory array between `"lease"` and `"plan"`.
- In `src/domain/layout.test.ts:101`, change the test name to `src/services/ holds exactly the fifteen capabilities plus home-lock`.
- In `eslint.config.js:9-18`, add `"@earendil-works/*"` to `vendorPackages`. This bans it in `src/domain/` (block at `:230-247`) and in `src/commands/` and `src/queries/` (block at `:248-274`) with no further edit.
- Add one new block to `eslint.config.js` immediately after the `src/**/*.ts` block that ends at `:229`, and before the `src/domain/**/*.ts` block at `:230`:
  - `files: ["src/services/*/index.ts"]`, `ignores: ["src/**/*.test.ts"]`.
  - One `no-restricted-imports` rule whose `patterns` hold three groups: `vendorPackages` with a message stating a service interface names no vendor package; `gitLibraries` with the message of `:217-218`; and `["node:child_process"]` with the message of `:221-223`.

## Constraints

- Flat config resolves `no-restricted-imports` by last match and never by union (`eslint.config.js:204-207`), so the new block must repeat the `gitLibraries` and `node:child_process` entries of the `src/**/*.ts` block rather than rely on it.
- Place the new block before the `src/domain/`, `src/commands/`, `src/queries/`, `src/http/contract/` and `src/cli/` blocks so their globs, which do not overlap `src/services/*/index.ts`, are unaffected. Verify by running the lint assertions below.
- Add `"model"` to the array only. `Deadline` and `SystemDeadline` sit in the existing `clock` capability, so the list gains one name.
- Do not add `src/services/model/not-implemented.ts`. `src/domain/layout.test.ts:144-157` names only `agent`, `verify` and `lease`.
- Change no `boundaries/*` setting. `src/services/model/` is already matched by the `service` element pattern `src/services/*` (`eslint.config.js:65-70`).

## Verify

- Add these `lintCase` tests to `src/domain/layout.test.ts`, following the shape at `:220-229`, each using `code: 'import { createModels } from "@earendil-works/pi-ai";'`:
  - `filePath: "src/services/model/index.ts"` reports `no-restricted-imports`.
  - `filePath: "src/commands/provider/x.ts"` reports `no-restricted-imports`.
  - `filePath: "src/domain/x.ts"` reports `no-restricted-imports`.
  - `filePath: "src/services/model/pi-ai.ts"` reports no `no-restricted-imports`.
  - `filePath: "src/services/model/pi-ai-models.ts"` reports no `no-restricted-imports`.
  - `filePath: "src/main.ts"` reports no `no-restricted-imports`.
- Add one test asserting `src/services/model/index.ts` exists, with `fs.existsSync` through `fileURLToPath`, following `:144-157`. Story 7 adds the matching assertion for `src/services/clock/system-deadline.ts`.
- Run `node --test --test-timeout=60000 src/domain/layout.test.ts`; it exits 0.
- Run `npm run lint`; it exits 0.
- `npm run verify` exits 0. This story closes the Story 1 + Story 11 pair.
- Proof: `PASS EPIC-102`, and Hermetic coverage lines 79 and 80.
