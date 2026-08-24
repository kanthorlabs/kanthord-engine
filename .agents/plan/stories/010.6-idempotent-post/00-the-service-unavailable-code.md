# Story 0 — The `503` code

Epic: `.agents/plan/epics/010.6-idempotent-post.md`

Dispatch this story **first**. Stories 4 and 5 throw the code it adds.

## Change

The API gains a twenty-second error code. Every pinned list moves from twenty-one to twenty-two, and
each one is named below. `docs/proposal/api/README.md` already carries the row and the rationale;
this story brings the code and the CLI into line with it.

### 1. `src/http/contract/errors.ts:3-25` — the code

Add one entry to `errorStatuses`, **after** `"not-implemented": 501,` and as the last entry:

```ts
  "service-unavailable": 503,
```

Declaration order in this object is asserted, and it is ascending by status. `503` follows `501`.

`PreconditionCode` (`errors.ts:29-31`) selects the `409` codes by a conditional type, so a `503`
never enters it and `httpError("service-unavailable", message)` takes no `details` argument. Do not
add an overload.

### 2. `src/cli/exit-code.ts:8-27` — the exit code

Add one entry to `exitCodes`, after `"not-implemented": 220,` and as the last entry:

```ts
  "service-unavailable": 230,
};
```

The `5xx` family already reads `internal-error: 210`, `not-implemented: 220`. `230` continues it.
The value must be distinct from every existing one and from `DAEMON_FAULT = 200`.

### 3. `src/http/contract/errors.test.ts` — the three pinned lists

- `:25-49` `"pins the twenty-one codes in table order"` — append `"service-unavailable"` after
  `"not-implemented"`, and rename the test to `"pins the twenty-two codes in table order"`.
- `:51-85` `"groups the codes by status"` — add
  `assert.deepEqual(groups[503], ["service-unavailable"]);` after the `groups[501]` line, and change
  `assert.equal(sum, 21)` at `:84` to `22`.
- `:13-23` `"matches the proposal code table"` needs **no** edit. It reads the markdown table through
  `readErrorCodeMatrix()` (`test/helpers/proposal.ts:89`) and compares both directions, so it turns
  green only because the proposal row is already there. That is the assertion proving this story did
  not invent a code.

### 4. `src/cli/exit-code.test.ts` — the two pinned lists

- `:14-35` the `expected` map — append `"service-unavailable": 230,`.
- `:47-59` `"each of the twenty-one codes maps to its literal exit code"` — change
  `assert.equal(count, 21)` to `22`, and rename the test to `"each of the twenty-two codes maps to
its literal exit code"`.
- The `"exitCodes keys match errorStatuses keys bytewise"` test at `:41-46` needs no edit; it is the
  guard that fails if only one of the two files is updated.

## Constraints

- `docs/proposal/api/README.md` is the source of truth and already holds the row. Do not edit it, and
  do not change its wording.
- Do not add the code to `PreconditionCode`, and do not give it a `details` overload.
- Do not use `service-unavailable` anywhere yet. Stories 4 and 5 are its only two call sites, and
  they land later.
- Change no other error code, no status, and no exit code.

## Verify

`node --test src/http/contract/errors.test.ts src/cli/exit-code.test.ts` — both pass with the edits
above. Add to `errors.test.ts`:

- `assert.equal(errorStatuses["service-unavailable"], 503)`.
- `httpError("service-unavailable", "declined")` yields `status === 503` and
  `errorEnvelope(...)` deep-equals
  `{ error: { code: "service-unavailable", message: "declined" } }` — no `details` key.
- `assert.equal(Object.keys(errorStatuses).length, 22)`.
- The existing `"keeps every code kebab-case"` test at `:87-90` covers the new code with no edit.

Add to `exit-code.test.ts`:

- `assert.equal(exitCodeForError("service-unavailable", 503), 230)`.
- `assert.equal(new Set(Object.values(exitCodes)).size, 22)` — every exit code is distinct.

`npm run verify` exits 0. `src/http/contract/parity.test.ts` and `src/http/contract/openapi.test.ts`
need no edit: this story adds an error code, not a registry entry, and the OpenAPI document names
only the `Error` schema.

Proof: delivers `src/http/contract/errors.test.ts` in the EPIC Proof command, and the Proof line
"`service-unavailable` is `503`, sits after `not-implemented` in the code table, and matches the
proposal table."
