# Story 11 — `repository.list` and `repository.show`

Epic: `.agents/plan/epics/007-repository-registration.md`
Depends on: Story 10 (a registered row), Story 09 (`createBinaryGit`).

The projection carries the branch fields, the landing tip, the tracking tip, `fetchedUpstreamOid`, the bound credential, and the repository state. P1-E3 asserts the ref layout through this route alone.

## Change

### 1. `src/queries/repository/show-repository.ts` (new)

```ts
export type RepositoryTips = Readonly<{
  landingOid: string | null;
  trackingOid: string | null;
}>;

export type BoundCredential = Readonly<{ id: string; name: string }>;

export type RepositoryView = Readonly<{
  id: string;
  name: string;
  remoteUrl: string;
  credential: BoundCredential;
  upstreamBranch: string;
  landingBranch: string;
  landingRef: string;
  trackingRef: string;
  publishRef: string;
  publishOnApproval: boolean;
  state: "ready" | "needs-reconcile";
  landingOid: string | null;
  trackingOid: string | null;
  fetchedUpstreamOid: string | null;
  divergedLandingOid: string | null;
  divergedUpstreamOid: string | null;
  updatedAt: number;
}>;

export type ShowRepositoryDependencies = Readonly<{
  storage: Storage;
  git: Git;
}>;

export function showRepository(
  dependencies: ShowRepositoryDependencies,
  input: Readonly<{ id: string }>,
): Promise<RepositoryView | null>;
```

One statement, columns named and joined to the credential so a caller needs one request:

```sql
SELECT r.id, r.name, r.remote_url, r.credential_id, p.name AS credential_name,
       r.home_path, r.upstream_branch, r.landing_branch, r.publish_ref,
       r.publish_on_approval, r.state, r.diverged_landing_oid,
       r.diverged_upstream_oid, r.fetched_upstream_oid, r.updated_at
FROM repository r JOIN provider p ON p.id = r.credential_id
WHERE r.id = ?
```

The join is safe and mandatory: `repository.credential_id` is `NOT NULL REFERENCES provider(id)`, so the row always exists, and `docs/proposal/api/repository.md:90` requires the bound credential's id **and its current name**. No payload column is selected, so no ciphertext leaves the query.

`landingRef` is `"refs/heads/" + landing_branch` and `trackingRef` is `"refs/remotes/origin/" + upstream_branch`. Both are rendered, never stored. `docs/proposal/api/repository.md:94` requires the response to name the landing branch and the tracking namespace explicitly, because the client host cannot read the daemon file system.

The two tips are read from the home **after** the row read and **outside** any transaction:

- `landingOid` is `await git.resolveRef({ gitDir: home_path, ref: landingRef })`.
- `trackingOid` is `await git.resolveRef({ gitDir: home_path, ref: trackingRef })`.

`resolveRef` returns `null` for an absent ref and for a `gitDir` that is not a repository — EPIC 006 Story 07 fixes both, and an unreadable home is EPIC 007.5's refusal, not this query's. A `null` tip is therefore a reported value, not an error.

`publishOnApproval` is `publish_on_approval === 1`. The column is an integer; the projection is a boolean, because a client routes on a boolean.

`home_path` is read and **never returned**. `docs/proposal/api/README.md:188` forbids a server path in a response, and `RepositoryView` has no member that can carry one.

An absent row returns `null`.

### 2. `src/queries/repository/list-repository.ts` (new)

```ts
export function listRepositories(
  dependencies: ShowRepositoryDependencies,
  input: Readonly<{ state?: "ready" | "needs-reconcile" }>,
): Promise<readonly RepositoryView[]>;
```

The same column list with no `WHERE r.id = ?` and with `ORDER BY r.id ASC`. `input.state` appends `WHERE r.state = ?`, as a second literal statement string rather than a concatenation.

The two tips are read for every row, sequentially in the returned order. Sequential and not concurrent: each read is a `git` process, and a list of forty repositories launching eighty processes at once would compete with the daemon's own work. The order is the returned order, so the process order is deterministic.

`ORDER BY r.id ASC` is the order rule. A repository id carries a ULID whose prefix is monotonic, so registration order is recovered with no timestamp column, and the primary key makes the sort total.

### 3. `src/http/contract/repository.ts` — schemas on `list` and `show`

```ts
export const repositoryView = z.object({
  id: z.string(),
  name: z.string(),
  remoteUrl: z.string(),
  credential: z.object({ id: z.string(), name: z.string() }),
  upstreamBranch: z.string(),
  landingBranch: z.string(),
  landingRef: z.string(),
  trackingRef: z.string(),
  publishRef: z.string(),
  publishOnApproval: z.boolean(),
  state: z.enum(["ready", "needs-reconcile"]),
  landingOid: z.string().nullable(),
  trackingOid: z.string().nullable(),
  fetchedUpstreamOid: z.string().nullable(),
  divergedLandingOid: z.string().nullable(),
  divergedUpstreamOid: z.string().nullable(),
  updatedAt: z.number(),
});

export const repositoryListResponse = z.object({
  repositories: z.array(repositoryView),
});
export const repositoryShowResponse = repositoryView;
```

`repository.register`'s response schema (Story 10) becomes `repositoryView` as well, so one shape serves all three routes and a client parses one type. Update Story 10's `repositoryRegisterResponse` to `repositoryView`, and update the `register` command to return the same view — it calls `showRepository` after its transaction commits rather than assembling a second literal.

The profile hash of `docs/proposal/api/repository.md:90` is **not** a member. `repository.profile` is a phase-2 operation and no profile can be bound in phase 1, so a member that is always `null` would be contract for a value the phase cannot produce.

### 4. `src/http/server/repository/list-repository.ts` and `show-repository.ts` (new)

Each parses, calls one query, and formats. `show` answers `httpError("not-found", `no repository ${id}`)` on a `null` result. `list` reads no query parameter, for the reason Story 04 gives for `provider.list`.

### 5. `src/main.ts` — bind two handlers

Add `"repository.list"` and `"repository.show"`. The `unimplemented` filter shrinks by two with no edit.

### 6. Contract test counts — the final values for this epic

- `src/http/contract/registry.test.ts`: the `request` list deep-equals `["provider.register","repository.inspect","repository.register"]`; the `response` list deep-equals `["provider.list","provider.register","provider.show","repository.inspect","repository.list","repository.register","repository.show"]`. Both bytewise sorted. Seven routed operations carry a response and three carry a request, which is the tally `.agents/plan/stories/004-transport-skeleton/index.md` records for this epic.
- `src/http/contract/openapi.test.ts`: `components.schemas` keys deep-equal the bytewise-sorted list

  ```
  Error
  provider.list.response
  provider.register.request
  provider.register.response
  provider.show.response
  repository.inspect.request
  repository.inspect.response
  repository.list.response
  repository.register.request
  repository.register.response
  repository.show.response
  ```

  Eleven keys: one error schema, three requests and seven responses.

- `openapi.test.ts:190-193` — no entry sets `successStatus` — stays green. This epic sets none.
- `openapi.test.ts:112-120` (53 operations), `:80` (47 paths), `registry.test.ts:21` (53 entries), `:37-38` (23 routed / 30 stubbed) and `parity.test.ts:16` (53 comparable) are all unchanged. This epic adds no operation, edits no path, and changes no `status`.

## Constraints

- No query selects `*`, and no query selects a payload column.
- `home_path` never reaches a response.
- The two `resolveRef` calls are outside every transaction. `Transaction` is synchronous and `resolveRef` is not.
- `list` reads tips sequentially, in the returned order.
- The order is `ORDER BY r.id ASC` in both queries.
- A `null` tip is a value, not an error. The query never throws for an unreadable home.
- `RepositoryView` has no optional member. Every field is present, and an unknown value is `null`.

## Verify

`node --test src/queries/repository/show-repository.test.ts src/queries/repository/list-repository.test.ts src/http/server/repository/show-repository.test.ts src/http/server/repository/list-repository.test.ts src/http/contract/registry.test.ts src/http/contract/openapi.test.ts`

The `git` dependency is a Mock `Git` whose `resolveRef` returns a value per `(gitDir, ref)` pair the case names and throws for an unnamed pair, so an unexpected read is a failure. Rows are written with `seedRegistry` from `test/helpers/rows.ts`, which already seeds one `provider` and one `repository`, plus direct `transact` writes for the cases that need a second row.

### `show-repository.test.ts`

- A registered repository returns a view whose every field is asserted, and `Object.keys(view)` bytewise sorted deep-equals the seventeen member names. A field-count assertion is what catches a member added without a schema.
- `landingRef` equals `"refs/heads/" + landing_branch` and `trackingRef` equals `"refs/remotes/origin/" + upstream_branch`, for a landing branch of `main` and for one of `kanthord/main`. The second case proves the render is a concatenation and not a lookup.
- `credential` deep-equals `{ id: <the provider id>, name: <the provider's current name> }`. Then rename the provider row with a direct write and assert the view reports the new name — the join reads the current name, not a copy.
- `publishOnApproval` is `true` for a stored `1` and `false` for a stored `0`.
- `landingOid` and `trackingOid` equal the Mock's values, and the Mock recorded exactly two `resolveRef` calls, with `landingRef` first.
- **A missing ref is `null`, not an error.** A Mock returning `null` for the tracking ref yields `trackingOid: null` and the call resolves.
- **An unreadable home is `null`, not an error.** A Mock returning `null` for both yields both `null` and the call resolves. `resolveRef` swallowing an absent `gitDir` is EPIC 006's contract, and this asserts the query relies on it.
- A `needs-reconcile` row with both `diverged_*` set returns them, and `state === "needs-reconcile"`.
- An unknown but well-formed id returns `null`.
- **No path and no ciphertext.** `JSON.stringify(view)` contains neither the row's `home_path` nor the string `payload`, and `Object.hasOwn(view, "homePath")` is `false`.
- **The statement names its columns.** Read the module source and assert it contains no `SELECT *`.

### `list-repository.test.ts`

- Three repositories return three views in ascending `id` order. Insert them with names whose alphabetical order is the reverse of the id order and assert the returned order follows the id.
- `{ state: "needs-reconcile" }` returns only that row.
- An empty table returns `[]`.
- **The tips are read in the returned order.** The Mock records `(gitDir, ref)` pairs; assert the recorded sequence is repository one's landing, repository one's tracking, repository two's landing, and so on. Six recorded calls for three repositories, in that exact order. This is the determinism rule: same input, same order.
- Every view passes `repositoryView.safeParse(...).success === true`.

### The two handler tests

- `GET /v1/repository` answers `200` with `{ repositories: [...] }`, and `repositoryListResponse` parses the body.
- `GET /v1/repository/repo_01HZY8QF3M4N5P6R7S8T9V0W1X` with a `null` stub answers `404` with `error.code === "not-found"`.
- `GET /v1/repository/<a valid id>` answers `200` and `repositoryShowResponse` parses the body.
- `POST /v1/repository/<id>/landing-branch` answers `501` with a message ending in `"ships in phase-2"`, and the test compares `SELECT COUNT(*) FROM repository` and `SELECT COUNT(*) FROM event` before and after to assert nothing was written. The same for `POST /v1/repository/<id>/reconcile`. This is the `AGENTS.md` rule for a `stubbed` route, asserted against database state.
- No response body contains a daemon path, asserted on the successful `show` and `list` bodies.

### E2E — scenario `E7-11`, real `github.com`

File `scripts/e2e/007/11-repository-projection.e2e.ts`. **This scenario is P1-E3's mechanism: the ref layout is asserted through the route alone.**

- Register the credential and the repository as Story 10's scenario does, then `GET /v1/repository/:id`.
- The body parses against `repositoryShowResponse`.
- `landingRef` equals `` `refs/heads/${env.ghBaseBranch}` ``, and `trackingRef` equals `` `refs/remotes/origin/${env.ghBaseBranch}` ``.
- `landingOid`, `trackingOid` and `fetchedUpstreamOid` are all equal, all match `/^[0-9a-f]{40}$/`, and all equal `remoteRefValue` for the base branch read independently of the daemon. That single equality is the whole ref-layout assertion: the landing branch exists at the fetched upstream tip, and the tracking ref observes the same object.
- `state` is `"ready"`, and both `diverged_*` members are `null`.
- `credential.id` equals the registered provider id and `credential.name` equals the name the scenario registered. Rename is a phase-2 route, so the name is asserted as registered.
- `publishOnApproval` is `true`, and `publishRef` equals the scratch ref the registration carried.
- **No response names a server path.** `JSON.stringify(body)` contains no `/` followed by `repos/`, does not contain the temporary home path, and `Object.hasOwn(body, "homePath")` is `false`.
- **No response carries a credential field.** `JSON.stringify(body)` does not contain `env.ghToken`.
- `GET /v1/repository` includes the registration, and the body parses against `repositoryListResponse`.
- `GET /v1/repository/repo_01HZY8QF3M4N5P6R7S8T9V0W1X` answers `404`.
- `POST /v1/repository/<id>/reconcile` answers `501`, and a following `GET /v1/repository/:id` returns a body deep-equal to the earlier one. A stubbed route wrote nothing, asserted through the product's own read.
- The scenario creates no remote ref, and `deleteScratchRefs` runs in an `after` hook.

`npm run verify` exits 0. `npm run e2e:007` exits 0.

Proof: contributes `src/queries/repository/show-repository.test.ts` and `src/queries/repository/list-repository.test.ts` to the epic Proof glob `src/queries/repository/**/*.test.ts`.
