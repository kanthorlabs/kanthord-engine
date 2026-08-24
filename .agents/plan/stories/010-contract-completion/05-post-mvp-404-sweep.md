# Story 05 — the `post-mvp` `404` sweep

Epic: `.agents/plan/epics/010-contract-completion.md`
Depends on: nothing in this epic. Dispatch it in parallel with Story 01.

`docs/proposal/api/README.md:54` — "A `post-mvp` row has no route at all … a request to it returns `404`". `:56` — "`501` says 'this daemon will do it, not yet'. `404` says 'this daemon does not have this operation'." Nothing asserts it today. `src/http/contract/parity.test.ts:24-36` pins the four deferred ids as **absent from the registry**, which is a registry fact, not a wire fact.

The source for this sweep is the proposal matrix, never the registry, because a `post-mvp` row has no registry entry. `src/http/contract/parity.test.ts:12-22` compares `routed` and `stubbed` only. **These two sources must not be swapped** (`.agents/plan/epics/010-contract-completion.md:33`).

## Change

No production file changes. This story adds cases to one test file.

### `src/http/server/route.test.ts` — four new cases

`readRouteMatrix()` from `test/helpers/proposal.ts:59-88` is called once at module scope, matching `src/http/contract/parity.test.ts:9`. `ProposalRoute` carries `operationId`, `method`, `path`, `introducedIn`, `status`, `source` (`test/helpers/proposal.ts:44-51`).

```ts
const postMvp = readRouteMatrix()
  .filter((row) => row.introducedIn === "post-mvp")
  .sort((a, b) =>
    Buffer.compare(Buffer.from(a.operationId), Buffer.from(b.operationId)),
  );
```

#### Case 1 — `"the proposal declares four post-mvp rows"`

- `postMvp.map((row) => row.operationId)` deep-equals, in this exact order:

  ```
  ["binding.e2e.project",
   "binding.provider.agents",
   "binding.provider.project",
   "event.stream"]
  ```

- `postMvp.map((row) => `${row.method} ${row.path}`)` deep-equals, in the same order:

  ```
  ["PUT /v1/project/:id/binding/e2e",
   "PUT /v1/agent/:role/binding/provider",
   "PUT /v1/project/:id/binding/provider",
   "GET /v1/event/stream"]
  ```

- Every row has `status === "deferred"`, and every row in the whole matrix with `status === "deferred"` has `introducedIn === "post-mvp"`. This pins that the two columns coincide, so a later row that sets one and not the other fails here rather than escaping the sweep.
- `postMvp.length` is not asserted separately: the two deep-equals above already fix it at four.

#### Case 2 — `"every post-mvp path answers 404 and never 501"`

For each of the four rows, against `await createTestApp()` with an empty handler bag:

- Render the concrete path as `row.path.replace(/:[^/]+/g, "x_01")`.
- Drive it with `row.method` through `drive`, imported from `test/helpers/app.ts` where Story 01 exports it. Do not write a local copy.
- `response.status` is `404`, asserted with `row.operationId` as the message so a failure names which row regressed. **A separate `status !== 501` assertion is redundant** — `=== 404` already excludes it — and is not written.
- `response.body.error.code` is `"not-found"`.
- The message contains the method and the concrete path, matching `src/http/server/route.ts:16-19`.
- The loop counter equals `postMvp.length`. Case 1's deep-equal already pins that to four, so no second literal is written here.

#### Case 3 — `"a post-mvp row has no registry entry, and the matrix has no third kind of row"`

- No `post-mvp` operation id appears in `registry`: for each of the four, `findOperation(id)` is `undefined`. This is what makes `route.ts` the only code that can answer them, and therefore why the answer is `404`.
- `readRouteMatrix().length` is `57`, the `routed` plus `stubbed` rows number `53`, and `postMvp.length` is `4`. Assert `53 + 4 === 57` as an equation, so a matrix row carrying none of the three statuses fails rather than being skipped by both sweeps.

**This case does not prove "the two sources are not swapped", and must not claim to.** `src/http/contract/parity.test.ts:12-22` already makes the registry's routed and stubbed set equal the proposal's, so a `501` sweep reading the proposal would behave identically today and no set arithmetic can tell the two apart. Provenance is structural: Story 04's sweep iterates `registry` and this file's sweep iterates `readRouteMatrix()`, and that is visible in the source rather than in an assertion. The intersection of the stubbed ids and the four post-mvp ids is empty by construction of the previous bullet and is not asserted separately.

#### Case 4 — `"a post-mvp path is unreadable without the token"`

`docs/proposal/api/README.md:207` — "a registered path and an unregistered path answer identically" without the token. For each of the four rows, drive the concrete path through `app.raw` with no `Authorization` header but with the allowed `Host`:

- `response.status` is `401`, never `404`.
- `response.body.error.code` is `"unauthenticated"`.

This is the assertion that the route table stays unreadable, and it is the same ordering `src/http/server/app.test.ts:68-76` already proves for an unknown path.

## Constraints

- No production file changes at all. `src/http/server/route.ts:16-19` already answers `404` for an unmatched path; this story proves the post-mvp rows reach it.
- The sweep reads `docs/proposal/api/` and never `registry`, except in Case 3 where the point is that the two disagree.
- No file under `docs/` is edited.
- `test/helpers/proposal.ts` is not edited. `readRouteMatrix` already excludes `README.md` and `new-decisions.md` (`test/helpers/proposal.ts:59-88`).
- Ordering is bytewise through `Buffer.compare`, never a bare `.sort()`.
- The four expected ids and paths are literals. If a proposal row is added, this test fails and its author updates one list — that is the intended cost.

## Verify

```bash
node --test src/http/server/route.test.ts src/http/contract/parity.test.ts
```

- The four new cases pass, and every existing case in `src/http/server/route.test.ts` stays green unchanged.
- `src/http/contract/parity.test.ts` is untouched and stays green. It pins the same four ids from the registry side; this story pins them from the wire side.

**One failure is proved by hand and then reverted.** Add a fifth entry to the expected id list of Case 1. The test fails on the deep-equal rather than passing with a shorter loop. Remove it.

`npm run verify` exits 0.

Proof: contributes the `src/http/server/route.test.ts` cases. They are not inside the EPIC Proof glob — see B1 in the index.
