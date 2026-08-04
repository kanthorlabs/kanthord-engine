# Story 10 — `repository.register`

Epic: `.agent/plan/epics/007-repository-registration.md`
Depends on: Story 06 (the credential resolution), Story 08 (`confirmHostKey`), Story 09 (`seedHome`, `createBinaryGit`).

The three branch fields and `publishOnApproval` from the body, the confirmed `hostFingerprint` for an ssh url, the repeated preflight, the seeding, the baseline `sync` row, and the event. It also delivers EPIC 006's outside-writer refusal as a command — with no route in this epic, per B5.

## Change

### 1. `src/commands/repository/register-repository.ts` (new)

```ts
export type RegisterRepositoryDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
  git: Git;
  readRepositoryView: (id: string) => Promise<RepositoryView | null>;
  homeRoot: string;
}>;

export type RegisterRepositoryInput = Readonly<{
  name: string;
  remoteUrl: string;
  credentialId: string;
  upstreamBranch: string;
  landingBranch: string;
  publishRef: string;
  publishOnApproval: boolean;
  hostFingerprint: string | null;
  actor: string;
}>;

export type RegisterRepositoryRefusal =
  | "name-taken"
  | "credential-not-found"
  | "credential-wrong-kind"
  | "credential-unreadable"
  | "host-fingerprint-required"
  | "host-fingerprint-forbidden"
  | "host-key-mismatch"
  | "host-key-unavailable"
  | "outside-writer";

export class RegisterRepositoryError extends Error {
  readonly refusal: RegisterRepositoryRefusal;
  readonly detail: string;
  readonly presented: readonly string[];
  readonly confirmed: string | null;
  constructor(refusal, message, options?);
}

export type RegisterRepositoryResult = RepositoryView;

export function registerRepository(
  dependencies: RegisterRepositoryDependencies,
  input: RegisterRepositoryInput,
): Promise<RegisterRepositoryResult>;
```

The function is **asynchronous**, and the transaction is not. Everything that touches the network or the file system happens before the transaction opens, and the transaction is one synchronous callback at the end. `src/services/storage/connection.ts:90-101` rolls back and throws on a returned promise, so an `await` inside `transact` is not merely discouraged — it is refused.

Sequence, in this exact order:

1. `git.remoteUrlVerdict(input.remoteUrl)`. A refusal throws `GitError("url-refused", verdict.reason, "")`.
2. The command validates no branch field. Every shape rule on `name`, `upstreamBranch`, `landingBranch`, `publishRef` and `hostFingerprint` is a zod rule in `repositoryRegisterRequest` below, so a missing or malformed field is `400 invalid-request` before the command runs. The command receives validated strings and asserts nothing about them.
3. **Resolve the credential with this file's own copy of `resolveGitCredential`.** Copy the function, `CREDENTIAL_SQL` and the runtime shape check verbatim from Story 06, changing only the three refusal messages to name `repository.register`. It is duplicated, not shared: `eslint.config.js:121-129` lets a command reach `domain/` and a service interface and nothing else, so a command may not import a query, and `AGENTS.md` admits no third layer between them. Both copies are covered by their own tests asserting the same four refusal names, so a divergence fails one of them — see S5.

   `showProvider` cannot serve here either. Its `ProviderView` carries the public projection and no ciphertext.

4. **The `hostFingerprint` rule.** When `verdict.transport === "ssh"` and `input.hostFingerprint` is `null`, throw `RegisterRepositoryError("host-fingerprint-required", "an ssh url needs a confirmed hostFingerprint")`. When `verdict.transport === "http-basic"` and `input.hostFingerprint` is not `null`, throw `RegisterRepositoryError("host-fingerprint-forbidden", "an http-basic url has no host key")`. `docs/proposal/api/repository.md:44` refuses the field for that transport, and `:58` makes the missing one a `400`. The daemon infers nothing here.
5. **The re-scan.** For an ssh url, `git.confirmHostKey({ remoteUrl, hostFingerprint })`. A `reason === "fingerprint-mismatch"` throws `RegisterRepositoryError("host-key-mismatch", `the host presented no key matching ${hostFingerprint}`, { presented: outcome.presented, confirmed: hostFingerprint })`. A `reason === "scan-failed"` throws `RegisterRepositoryError("host-key-unavailable", …, { detail: outcome.detail })`. The confirmed key from the outcome is what step 6 passes to the seed, never a value from the body.
6. Mint the identity and the paths: `repositoryId = ids.mint("repository")`, `homePath = join(dependencies.homeRoot, "repos", input.name + ".git")`, `pidFile = join(paths.runDirectory, `seed-${repositoryId}.pid`)`.

   `homeRoot` is `settings.home`, injected. `homePath` is derived from the repository **name**, which the body supplies and which is unique in the table. A name carrying `/` or `..` would escape the tree, and `repositoryName` in section 3 refuses both.

7. `git.seedHome({ gitDir: homePath, remoteUrl, upstreamBranch, landingBranch, credential, publishRef, hostKey, pidFile })`. It runs the repeated preflight, the fetch, the landing write and the rename, and it returns `{ homePath, fetchedUpstreamOid, landingOid }`. A thrown `GitError` propagates; the seed already removed its staging directory and left no visible home.
8. `git.resolveRef({ gitDir: homePath, ref: "refs/heads/" + input.landingBranch })` to read the landing tip the transaction records. It equals `result.landingOid`, and it is read again because the value the row records must be an observation of the visible home rather than of the staging one.
9. `now = clock.now()`, `gitOperationId = ids.mint("gitOperation")`.
10. **One transaction.** Inside `storage.transact`:
    - `SELECT id FROM repository WHERE name = ?`. A row throws `RegisterRepositoryError("name-taken", …)`, which rolls back. The check is inside the transaction because two concurrent registrations would otherwise both pass a pre-check.
    - `INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)` with `state` `'ready'`, both `diverged_*` `null`, `publish_on_approval` `input.publishOnApproval ? 1 : 0`.
    - **The baseline `sync` row.** `INSERT INTO git_operation (id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, child_token, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)` with `intent` `'sync'`, `node_id`/`run_id`/`candidate_id` `null`, `lease_fence` `0`, `ref` `'refs/heads/' + input.landingBranch`, `base_oid` `landingOid`, `proposed_head_oid` `landingOid`, `result_head_oid` `landingOid`, `expected_remote_oid` `null`, `state` `'complete'`, `outcome` `null`, `detail_blob` `null`, `child_token` `null`, `completed_at` `now`.

      `base_oid` and `proposed_head_oid` are both the landing object id because both columns are `NOT NULL` and a registration has no prior state; the seed created the ref at that value, so the base and the proposal are the same observation. `git-foundation.md:189` requires the baseline so a ref always has a recorded expectation, and EPIC 006 Story 07's `LAST_COMPLETED_SQL` reads exactly `state = 'complete' AND result_head_oid IS NOT NULL` filtered by intent, which this row satisfies.

    - `events.append(transaction, { subjectKind: "repository", subjectId: repositoryId, type: "repository.registered", actorKind: "human", actorId: input.actor, payload: { name, upstreamBranch, landingBranch, publishRef, publishOnApproval, credentialId, fetchedUpstreamOid, landingOid } })`.
11. `await dependencies.readRepositoryView(repositoryId)`, and throw a plain `Error` when it is `null` — the row was just committed, so a `null` is a defect and not a refusal.

    The view is **injected, not imported.** A command may not import a query, so `RegisterRepositoryDependencies` names a function and `src/main.ts` binds `showRepository` into it. That is the pattern `src/main.ts:75-119` already uses for the `migrate` handler. Assembling a second view literal here is refused: two literals for one wire shape drift, and Story 11 pins one.

**A refused credential writes one event.** When step 7's `seedHome` throws a `GitError` whose `failure` is `"auth-failed"` or `"permission-denied"`, the command opens one `storage.transact` and appends exactly one event before it rethrows:

```
subjectKind: "provider", subjectId: input.credentialId,
type: "repository.register.credentialRejected", actorKind: "human", actorId: input.actor,
payload: { failure, name: input.name, publishRef: input.publishRef, credentialId: input.credentialId }
```

`subjectKind` is `"provider"` because there is no repository to name: `git_operation.repository_id` is `NOT NULL REFERENCES repository(id)`, so the journal row the EPIC asks for cannot exist before the repository row, and `event.subject_id` is `anyIdentity` and accepts a provider id. The payload carries no url and no `GitError.detail`. Every other `GitError` failure appends nothing and rethrows unchanged — an unclassified transport failure is not a credential verdict. See B1.

12. Return the view.

**The event payload carries no url.** `remote_url` may hold a userinfo username, and an event row is plaintext read by `event.list`. The registered url is recoverable from the `repository` row, so the event names the fields a reader needs to see what was decided.

### 2. The outside-writer call site

EPIC 006 Story 07's `checkOutsideWriter` returns a verdict and writes nothing. `.agent/plan/stories/006-git-primitives/index.md:122` assigns the refusal and the event to this epic: the call site, the event inside the same transaction as the state decision, exactly one event on a mismatch, none on a match, and no `needs-reconcile` write.

This story delivers all five as one exported command, `assertNoOutsideWriter`, in `src/commands/repository/assert-no-outside-writer.ts`. It is **not** reached by `repository.register`: the check compares a ref against a recorded baseline, and registration writes the baseline and refuses an existing home, so at registration there is nothing to compare. The first production caller is the first repeat write path on a seeded home, which is a later epic. The EPIC bullet at `:24` records this: `repository.register` is the baseline writer, and the verdict's first caller is a later epic's repeat write path. See B5.

```ts
export type AdoptRepositoryDependencies = RegisterRepositoryDependencies;

export type AdoptRepositoryInput = Readonly<{
  repositoryId: string;
  gitDir: string;
  ref: string;
  intent: "merge" | "sync" | "publish" | "revert";
  actor: string;
}>;

export type AdoptVerdict = Readonly<{
  expected: boolean;
  expectedOid: string | null;
  observedOid: string | null;
}>;

export function assertNoOutsideWriter(
  dependencies: AdoptRepositoryDependencies,
  input: AdoptRepositoryInput,
): Promise<AdoptVerdict>;
```

It resolves the ref outside the transaction, then in **one** `storage.transact`:

- `checkOutsideWriter`'s query half — `lastCompletedOid({ transaction, repositoryId, ref, intent })` — reads the baseline.
- On a mismatch it appends **exactly one** event, `type: "repository.outsideWriter"`, `subjectKind: "repository"`, `subjectId: input.repositoryId`, payload `{ ref, intent, expectedOid, observedOid }`, and returns `{ expected: false, expectedOid, observedOid }`.
- On a match it appends nothing and returns `{ expected: true, … }`.

  The function returns a verdict and never throws for a mismatch. A throw from inside the callback would roll the transaction back and discard the event the refusal is supposed to record, so the transaction commits the event and the **caller** refuses on a `false` verdict. That is the read half and the write half in one transaction, which is what `docs/proposal/phase-1/domain.md` requires of a state decision and its event.

- It never writes `state = 'needs-reconcile'`. `git-foundation.md:189` says the mismatch "does not set `needs-reconcile`, which means a landing-to-upstream divergence and nothing else."

`resolveRef` is awaited **before** `transact`, because `Transaction` is synchronous. EPIC 006 Story 07 states the same split.

### 3. `src/http/contract/repository.ts` — schemas on `repository.register`

```ts
export const branchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/)
  .refine(
    (v) => !v.includes("..") && !v.endsWith("/") && !v.endsWith(".lock"),
    {
      message: "not a legal branch name",
    },
  );

export const repositoryName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const repositoryRegisterRequest = z.object({
  name: repositoryName,
  remoteUrl: z.string().min(1),
  credentialId: z.string().min(1),
  upstreamBranch: branchName,
  landingBranch: branchName,
  publishRef: z
    .string()
    .min(1)
    .regex(/^refs\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/),
  publishOnApproval: z.boolean().default(true),
  hostFingerprint: z
    .string()
    .regex(/^SHA256:[A-Za-z0-9+/]{43}$/)
    .nullable()
    .default(null),
});
```

`repositoryName` forbids `/` and `..`, which is what keeps `homePath` inside the daemon tree. `branchName` forbids a leading `-`, `..`, a trailing `/` and a trailing `.lock`, which is the subset of `git check-ref-format` this product needs and which the daemon enforces without running a process.

`publishOnApproval` defaults to `true`, per `docs/proposal/api/repository.md:64`. `hostFingerprint` defaults to `null`, so an absent field and an explicit `null` are one input.

A missing `upstreamBranch`, `landingBranch` or `publishRef` is `400 invalid-request` from the schema, which is `docs/proposal/api/repository.md:58`. A missing `hostFingerprint` on an ssh url is a `400` from step 4 of the command, because the schema cannot know the transport.

### 4. `src/http/server/repository/register-repository.ts` (new) and the refusal rows

| thrown                                            | `httpError` call                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `RegisterRepositoryError("name-taken")`           | `httpError("invalid-request", m, { refusal: "name-taken" })`                        |
| `…("credential-not-found")`                       | `httpError("not-found", m)`                                                         |
| `…("credential-wrong-kind")`                      | `httpError("invalid-request", m, { refusal: "credential-wrong-kind" })`             |
| `…("credential-unreadable")`                      | `httpError("invalid-request", m, { refusal: "credential-unreadable" })`             |
| `…("host-fingerprint-required")`                  | `httpError("invalid-request", m, { refusal: "host-fingerprint-required" })`         |
| `…("host-fingerprint-forbidden")`                 | `httpError("invalid-request", m, { refusal: "host-fingerprint-forbidden" })`        |
| `…("host-key-mismatch")`                          | `httpError("host-key-mismatch", m, { presented, confirmed })`                       |
| `…("host-key-unavailable")`                       | `httpError("invalid-request", m, { refusal: "host-key-unavailable", detail })`      |
| `…("outside-writer")`                             | `httpError("stale-revision", m, { expectedOid, observedOid })`                      |
| `GitError` with `failure === "url-refused"`       | `httpError("invalid-request", error.message, { refusal: "url-refused" })`           |
| `GitError` with `failure === "auth-failed"`       | `httpError("credential-rejected", error.message, { failure: "auth-failed" })`       |
| `GitError` with `failure === "permission-denied"` | `httpError("credential-rejected", error.message, { failure: "permission-denied" })` |
| `GitError` with `failure === "host-key-mismatch"` | `httpError("host-key-mismatch", error.message, { failure: "host-key-mismatch" })`   |
| `GitError` any other failure                      | rethrown, so `envelopeMiddleware` answers `500 internal-error`                      |

`error.detail` never reaches a `message`. `GitError.detail` can carry an absolute path — EPIC 006 measured `Unable to create '<absolute path>.lock'` — and `docs/proposal/api/README.md:188` forbids a server path in a response. The `details` object carries the classification, not the raw stderr.

### 5. `src/main.ts` — wire the git service

```ts
const git = createBinaryGit({
  runner: createGitRunner(gitPaths),
  paths: gitPaths,
});
```

`gitPaths` is the value Story 01 declared. Bind `"repository.register"` into `handlers`, with `homeRoot: settings.home`.

### 6. Contract test counts

- `registry.test.ts`: the `request` list becomes `["provider.register","repository.inspect","repository.register"]`, the `response` list gains `"repository.register"`.
- `openapi.test.ts`: `components.schemas` gains `"repository.register.request"` and `"repository.register.response"`.

## Constraints

- One transaction. The state write, the baseline journal row and the event share it. `Storage.transact` does not nest.
- No `await` inside a `transact` callback. Every network and file operation precedes it.
- The command never sets `state = 'needs-reconcile'` and never writes a `diverged_*` column.
- `homePath` is derived from `homeRoot` and the validated name. It is never taken from the request.
- `hostFingerprint` from the body is used only as the value `confirmHostKey` compares against. The key written to `known_hosts` is the scanned one.
- A failed registration writes no `repository` row and therefore no `git_operation` row — see the epic open items on the journal foreign key.
- No handler branches on a domain rule.

## Verify

`node --test src/commands/repository/register-repository.test.ts src/http/server/repository/register-repository.test.ts`

Dependencies are `createMigratedStorage()`, a Mock `IdGenerator` over a named ULID list, `createMockClock({ start: 1700000000000, step: 1000 })`, `AesGcmCrypto` over `Buffer.alloc(32, 7)`, and a hand-written Mock `Git` whose members return the values each case names and whose unnamed members throw.

### The happy path, http-basic

- Register with `upstreamBranch: "main"`, `landingBranch: "main"`, `publishRef: "refs/heads/main"`, `publishOnApproval: true`, `hostFingerprint: null`. Read the `repository` row with named columns and assert every field: `id` equals `` `repo_${ulids[0]}` ``, `state === "ready"`, `publish_on_approval === 1`, `diverged_landing_oid === null`, `diverged_upstream_oid === null`, `fetched_upstream_oid` equals the seed's value, `home_path` equals `join(homeRoot, "repos", "kanthord-verify.git")`, `updated_at === 1700000000000`.
- Exactly one `git_operation` row exists. Assert every column: `intent === "sync"`, `state === "complete"`, `outcome === null`, `lease_fence === 0`, `ref === "refs/heads/main"`, `base_oid === proposed_head_oid === result_head_oid === <the landing oid>`, `expected_remote_oid === null`, `node_id === run_id === candidate_id === null`, `child_token === null`, `completed_at === 1700000000000`.
- Exactly one `event` row exists, `type === "repository.registered"`, and its `payload_json` parsed deep-equals the eight named members and **contains no `remoteUrl` key**.
- `publishOnApproval: false` writes `publish_on_approval === 0`.
- The Mock `Git` records that `confirmHostKey` and `trustHostKey` were never called for an `http-basic` url, and that `seedHome` received `hostKey: null`.
- `seedHome` received `publishRef` equal to the body's value and a `pidFile` under `paths.runDirectory` whose name contains the repository id.

### The happy path, ssh

- With an `ssh://` url, a credential of transport `ssh`, and a `hostFingerprint` the Mock's `confirmHostKey` confirms: the row is written, and `seedHome` received the `hostKey` **from the confirm outcome**, not a value derived from the body. Assert by making the Mock return a key whose `fingerprint` equals the body value and whose `publicKey` is a distinct sentinel, then asserting `seedHome` saw that sentinel.

### The refusals, each writing nothing

Every case asserts `SELECT COUNT(*)` on `repository`, `git_operation` and `event` before and after. A comparison of state is the mechanism, not the throw.

- A duplicate name throws `name-taken`, and the first registration's three rows are unchanged — counts stay at `1`, `1`, `1`.
- An unknown `credentialId` throws `credential-not-found`; counts stay `0`.
- A credential of `kind === "llm"` throws `credential-wrong-kind`.
- A credential whose `payload_tag` has been zeroed throws `credential-unreadable`, and the message carries no crypto wording.
- **The two `resolveGitCredential` copies agree.** Import `CREDENTIAL_SQL` from this command and from Story 06's query and assert the two strings are equal. One equality assertion is what keeps the duplication of S5 honest.
- **A missing branch field is refused by the schema.** Assert through the handler test, not the command: the command's type makes the field mandatory, so the `400` belongs to the route.
- **An ssh url with `hostFingerprint: null` throws `host-fingerprint-required`**, and the Mock records no `confirmHostKey` call and no `seedHome` call.
- **An `http-basic` url with a `hostFingerprint` throws `host-fingerprint-forbidden`.**
- **A mismatch throws `host-key-mismatch` and seeds nothing.** The Mock's `confirmHostKey` returns `{ confirmed: false, reason: "fingerprint-mismatch", presented: ["SHA256:a…","SHA256:b…"] }`. The error's `presented` deep-equals that array and `confirmed` equals the body value, and `trustHostKey` and `seedHome` were never called.
- **A scan failure throws `host-key-unavailable`** with `detail` equal to the outcome's detail.
- **A `seedHome` throwing `GitError("auth-failed", …)` propagates, writes no row, and writes exactly one event.** `repository` and `git_operation` counts stay `0`; `event` count is `1`, with `subject_kind === "provider"`, `subject_id` equal to the credential id, `type === "repository.register.credentialRejected"`, and `payload_json` parsed deep-equal to the four named members. Assert the payload contains no `remoteUrl` key and no `detail` key. This is the epic's "the journal records `auth-failed`" relocated to the only table that can hold it — see B1.
- The same for `GitError("permission-denied", …)`.
- **Any other `GitError` writes no event.** `GitError("transport-failed", …)` and `GitError("lock-held", …)` each propagate with all three counts at `0`.
- A `seedHome` throwing `GitError("host-key-mismatch", …)` propagates, writes no row and no event.
- **A failed transaction leaves an orphan visible home, and that is tolerated.** Force the `INSERT` to fail by pre-inserting a row with the same name inside a competing transaction is not reachable, so instead drive the failure with a Mock `EventLog.append` that throws. Assert: the transaction rolled back so `repository` count is `0`, **and** `existsSync(homePath)` is `true`. `docs/proposal/phase-1/git-foundation.md:44` states this order deliberately — "The database row that names the home is committed after the directory is durable. A crash between the two leaves a complete home that no row references, which startup removes" — so "no repository row" is not "registration wrote nothing", and EPIC 007.5's sweep owns the residue. Asserting it here is what stops a later author from reordering the two.
- A refused url throws before the credential is read. Assert by pointing `dependencies.storage` at a closed `Storage` whose `transact` throws, and expecting the `GitError("url-refused")` rather than the storage error.

### `assertNoOutsideWriter`

- **A matching baseline writes no event.** Seed one `git_operation` row with `intent = 'sync'`, `state = 'complete'`, `result_head_oid = X`, then a Mock `Git.resolveRef` returning `X`. The verdict is `{ expected: true, expectedOid: X, observedOid: X }`, and `SELECT COUNT(*) FROM event` is unchanged.
- **A mismatch writes exactly one event, in the same transaction as the state decision.** With `result_head_oid = X` and `resolveRef` returning `Y`, the verdict is `{ expected: false, expectedOid: X, observedOid: Y }` and exactly **one** `event` row exists, `type === "repository.outsideWriter"`, payload deep-equal to `{ ref, intent, expectedOid: X, observedOid: Y }`. Call it twice with the same mismatch and assert two events — one per decision, not one per ref.
- **Neither path sets `needs-reconcile`.** After both cases, `SELECT state FROM repository` is `'ready'` and both `diverged_*` columns are `null`.
- **The event survives a caller's refusal.** In the test, wrap the call in a function that throws `RegisterRepositoryError("outside-writer", …)` on a `false` verdict. After the throw, the event row is still present. This is why the verdict is returned rather than thrown from inside the callback, and the wrapper is the shape the first production caller takes.
- **Two rows completing in one millisecond are ordered by identity.** Insert two `complete` rows with the same `completed_at` and different ids, in both insertion orders, and assert the same `expectedOid` — the higher id wins. This re-proves EPIC 006 Story 07's ordering at this call site, because the baseline this epic writes is what the query reads.
- `git_operation` rows of another `intent` are not baselines: insert a `'publish'` row at `Z` and assert the verdict still reads the `'sync'` row.

### The handler test

- `POST /v1/repository` with a valid body answers `200` and the response schema parses the body.
- A body missing `upstreamBranch` answers `400`, `error.code === "invalid-request"`, and the stub command was never called.
- The same for a missing `landingBranch` and a missing `publishRef`. Three separate cases; the epic requires each.
- `name: "Kanthord/Verify"` answers `400` — the name pattern refuses `/` and an upper-case letter, which is what keeps `home_path` inside the tree.
- `upstreamBranch: "../etc"` answers `400`. `upstreamBranch: "-x"` answers `400`. `landingBranch: "main.lock"` answers `400`.
- `publishRef: "main"` answers `400` — a publish ref is fully qualified.
- `hostFingerprint: "nope"` answers `400` from the pattern.
- An absent `publishOnApproval` reaches the stub as `true`; an absent `hostFingerprint` reaches it as `null`.
- Each of the fourteen refusal rows answers its declared status and code, one case per row, asserting `error.code` and the named `details` members.
- A `host-key-mismatch` answers `409` with `error.code === "host-key-mismatch"`, `error.details.presented` an array and `error.details.confirmed` the body value. The `outside-writer` refusal keeps `stale-revision`: a journal baseline that no longer matches _is_ a precondition the caller re-reads.
- A `GitError("auth-failed")` answers `422` with `error.code === "credential-rejected"`.
- A `GitError("lock-held")` answers `500` with `error.message === "internal error"`, and `app.internalErrors()` has length one. An unclassified failure is not silently mapped.
- **No response carries a daemon path.** For every refusal case, assert `JSON.stringify(body)` contains neither `homeRoot` nor the string `".git"` preceded by a `/`.

### E2E — scenario `E7-10`, real `github.com`

File `scripts/e2e/007/10-repository-register.e2e.ts`. Drives the real daemon over HTTP.

- Register the credential from `.env.e2e`, then `POST /v1/repository/inspect` and read `defaultBranch`.
- `POST /v1/repository` with `name: "kanthord-verify-<runId>"`, `remoteUrl: httpsUrl(env)`, `upstreamBranch: <the inspected default>`, `landingBranch: <the same>`, `publishRef: scratchRef(env, "register")` passed through `assertScratchRef`, `publishOnApproval: true`, answers `200`.
- The response's `state` is `"ready"`, `fetchedUpstreamOid` matches `/^[0-9a-f]{40}$/` and equals `remoteRefValue` for the base branch read independently.
- **The confirmation is load-bearing against the real remote.** `POST /v1/repository` with an `ssh://github.com` url, a credential of transport `ssh` whose key the scenario generates, and a `hostFingerprint` that is the fingerprint of a **different** generated key, answers `409`. `error.details.presented` is an array of `SHA256:` values, and `error.details.confirmed` is the supplied value. This is the epic coverage line "a request carrying a fingerprint the host does not present is `409`, proved by supplying a syntactically valid fingerprint that was never scanned" — against the real host, where the presented set is whatever GitHub offers.
- **An ssh url with no `hostFingerprint` answers `400`** with `error.details.refusal === "host-fingerprint-required"`.
- **An https url with a `hostFingerprint` answers `400`** with `refusal === "host-fingerprint-forbidden"`.
- **A missing branch field answers `400`.** Three cases, one per field.
- **A wrong token answers `422` and writes no row.** Register a credential holding `wrongCredential(env).token` and register a repository with it. The response is `422` with `error.code === "credential-rejected"`. Then, after the daemon exits, read `<home>/kanthord.db` and assert: `SELECT COUNT(*) FROM repository` counts only the successful registration; no `git_operation` row has `outcome = 'auth-failed'`, because `git_operation.repository_id` is `NOT NULL REFERENCES repository(id)` and the journal cannot hold one; and exactly one `event` row has `type = 'repository.register.credentialRejected'` whose `subject_id` is the wrong-token provider id. See B1.
- **An empty token never reaches this route, and this scenario asserts nothing about one.** `provider.register` refuses it with `400 invalid-request`, because Story 03 declares `token: z.string().min(1)`. Story 04's scenario holds that assertion.
- **The remote is unchanged.** The scratch publish ref is absent, the base branch object id is equal before and after, and `listRemoteRefs` reports no ref of this run. A registration reads and dry-runs; it never writes.
- **The seeded home has the right ref layout, read through the product.** Assert through `GET /v1/repository/:id` in Story 11's scenario, which is the route P1-E3 uses. This scenario asserts the file system directly as a second, independent check: `for-each-ref refs/heads` on `<home>/repos/<name>.git` reports exactly one ref, and `refs/tags` reports none.
- `deleteScratchRefs` runs in an `after` hook, and the temporary home is removed.

`npm run verify` exits 0. `npm run e2e:007` exits 0.

Proof: contributes `src/commands/repository/register-repository.test.ts` to the epic Proof glob `src/commands/repository/**/*.test.ts`.
