# Story 8 — `403 actor-forbidden`

Epic: `.agent/plan/epics/015-actor-identity.md`

Run this story **before** Story 7. `authorize.ts` cannot throw a code the contract does not hold.

## Change

- `src/http/contract/errors.ts:7-30`: insert `"actor-forbidden": 403,` into `errorStatuses` immediately after `"host-forbidden": 403,`. The ordered key list changes in exactly that one position. The map grows from 22 to 23 entries.
- `src/http/contract/error-baseline.ts:4-13`: add `"actor-forbidden": null,` to `baselineErrors`, in the same relative position — after `"host-forbidden"`. Every operation can refuse, so the code is baseline rather than per-operation. It carries no details schema.
- `docs/proposal/api/README.md:169-193`: add the row `| \`actor-forbidden\` | 403 | ... |`to the error code table, immediately after the`host-forbidden`row, following the column shape of the existing rows. The existing`readErrorCodeMatrix`assertion in`src/http/contract/errors.test.ts`compares the table with`errorStatuses`, so the two must agree.
- `src/cli/exit-code.ts`: add `"actor-forbidden": 132,` to `exitCodes`, immediately after `"host-forbidden": 131`. **The EPIC names neither this file nor a value, and both the entry and the value are forced.**
  - The **entry** is forced because `src/cli/exit-code.test.ts:44-48` asserts `Object.keys(exitCodes)` equals `Object.keys(errorStatuses)` bytewise, so an error code with no exit code fails the gate.
  - The **value** is forced by the allocation every one of the 22 existing codes already obeys, with no gap and no exception: each HTTP status owns a base, and the codes of that status take consecutive integers from the base in `errorStatuses` insertion order.

    | status | base | codes in order                                 |
    | ------ | ---- | ---------------------------------------------- |
    | 400    | 110  | `invalid-request` 110                          |
    | 401    | 120  | `unauthenticated` 120                          |
    | 403    | 130  | `origin-forbidden` 130, `host-forbidden` 131   |
    | 404    | 140  | `not-found` 140                                |
    | 409    | 150  | `stale-revision` 150 … `host-key-mismatch` 159 |
    | 422    | 160  | `plan-invalid` 160 … `credential-rejected` 163 |
    | 500    | 210  | `internal-error` 210                           |
    | 501    | 220  | `not-implemented` 220                          |
    | 503    | 230  | `service-unavailable` 230                      |

    `actor-forbidden` enters the 403 group at position 3, so its value is `130 + 2 = 132`. No other integer obeys the rule.

## Constraints

- The insert position is contract, not taste. `buildErrorEnvelope` at `src/http/contract/errors.ts:40-60` walks `Object.keys(errorStatuses)` in insertion order, and that walk fixes the member order of every operation's discriminated union, and therefore the bytes of the generated OpenAPI document and its examples. A code appended to the end of the map compiles and satisfies a count while it reorders the published contract.
- `actor-forbidden` is not `401`. The caller authenticated; it is the actor kind that is refused. `origin-forbidden` and `host-forbidden` are browser defences and do not fit.
- Add no details schema to `src/http/contract/error-details.ts`. The refusal carries a message only.
- Do not add this code in EPIC 014.

## Verify

- `src/http/contract/errors.test.ts`:
  - In `"pins the twenty-two codes in table order"` at `:28`, add `"actor-forbidden"` to the ordered literal array immediately after `"host-forbidden"`, and rename the case to `"pins the codes in table order"`. **The case states no count after this edit.** This assertion already exists and is the one the story keeps; it needs the new member and a title with no number.
  - In the same file, add `"actor-forbidden"` to the `groups[403]` deep-equal assertion, after `"host-forbidden"`.
  - **Replace the two pinned integers.** Delete the `assert.equal(sum, 22)` at `:89` and the `assert.equal(Object.keys(errorStatuses).length, 22)` at `:94`. Neither is replaced by a new count. The ordered-list assertion above is the single mechanism, because it subsumes both: a member added anywhere fails it, and a member added at the wrong position fails it too.
  - Add a case named `"the ordered list rejects a code at any position"`. It builds three variant key arrays from the real list — one with an extra name appended at the end, one with an extra name spliced into the middle, and one in which `"host-key-mismatch"` is moved out of its 409 group into the 422 group — and asserts `assert.throws` for each when compared against `Object.keys(errorStatuses)` through `assert.deepEqual`. Assert that the thrown `AssertionError` carries a differing index, so the failure output names the offending position.
- `src/cli/exit-code.test.ts`: add `"actor-forbidden": 132` to the `expected` map at `:14-36`, raise the pinned `count` from 22 to 23 at `:61`, and rename the case at `:51` from `"each of the twenty-two codes maps to its literal exit code"` to `"each of the twenty-three codes maps to its literal exit code"`.
- **Encode the allocation rule, so the value cannot drift.** The present case at `:76-82` asserts only the coarse band (100–199 for a 4xx code, 200–299 for a 5xx). Replace it with a case named `"every code takes its status base plus its position in that status group"`, which declares the status→base table above as a literal `Readonly<Record<number, number>>`, groups `Object.entries(errorStatuses)` by status **in insertion order**, and asserts for every code that its exit value equals `base[status] + indexWithinGroup`. This subsumes the band assertion, it makes `132` the only legal value for `actor-forbidden`, and it fails for a later epic that appends a code with an arbitrary number. Assert the table covers exactly the distinct statuses present in `errorStatuses`, so a new status class cannot slip in with no base.
- Run `node --test --test-timeout=60000 src/http/contract/errors.test.ts src/cli/exit-code.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts`; each exits 0. `coverage.test.ts:305-306` and `:289-290` read `errorStatuses` and `baselineErrors`, and `example.test.ts` validates every example against the widened envelope union.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-015`, and Hermetic coverage lines 145, 146 and 147.
