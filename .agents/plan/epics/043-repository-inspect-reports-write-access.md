# EPIC 043 — `repository.inspect` reports write access

Status: **draft**. It follows EPIC 042 by sequence order and closes Gap 4 of the dashboard handoff.

## Goal

A human proves a git credential may push before a repository exists, so the check a human can run
matches the check registration runs:

- `repository.inspect` accepts `requiredAccess`, and `"write"` runs the write advertisement;
- the response reports read and write as two independent verdicts;
- a write failure is a verdict in a `200` response, as a read failure already is;
- omitting `requiredAccess` behaves exactly as the operation does today.

## Non-goals

- **No new operation.** The capability extends `repository.inspect`. `POST /v1/repository/inspect`
  keeps its operation id, method and path.
- **No `422` for a write failure.** `repository.register` keeps mapping `auth-failed` and
  `permission-denied` to `422 credential-rejected` through
  `src/http/server/repository/refusals.ts:56-63`. `inspect` reports a refused credential as a `200`
  verdict, which is the convention `docs/proposal/api/repository.md:49` already states for the read
  side.
- **No registration bypass.** `repository.register` keeps its own preflight and repeats it. A
  successful inspect authorizes nothing, exactly as `docs/proposal/api/repository.md:57` states.
- **No persisted verdict.** No `lastVerifiedAt`, no health column, no cached result. The handoff
  states the dashboard does not want one.
- **No branch parameter.** `inspect` gains no `branch` field. The probe uses the branch the remote
  advertises as default.
- **No repository row.** The probe writes nothing outside its own temporary directory and seeds no
  home.
- **No `credential` member change.** The existing `credential: { reachable, refusal }` member keeps
  its exact shape and its exact values, so the current dashboard call site keeps working.

## Decisions

- **The probe is an ephemeral fetch, and it lives in the git service.** `canPush`
  (`src/services/git/preflight.ts:13-19`) requires a `gitDir` and a `proposedOid`, so a push
  advertisement needs a local repository holding a local object.
  `docs/proposal/api/repository.md:51` states the write advertisement cannot run on this route for
  that reason. The decision reverses that line: the git service gains one interface method that
  creates its own temporary bare repository, fetches the named branch, calls `canPush` with the
  fetched object id, and removes the temporary directory before it returns. `inspect` still seeds no
  home and still writes nothing that survives the call.

- **The method is `Git.probePush`, and the query calls it once.** `src/queries/repository/` imports
  service interfaces only, so the temporary directory, the fetch and the cleanup belong behind the
  interface. `probePush(input: ProbePushInput): Promise<PushPreflight>` takes
  `{ remoteUrl, branch, credential }` and returns the existing `PushPreflight` union. The
  implementation reuses `fetchTracking`, `resolveRef` and `canPush` unchanged, in the order
  `src/services/git/seed.ts:110-140` already uses. Cleanup runs on every path, including a thrown
  `GitError`.

- **The probe pushes the fetched upstream object at the publish ref of the advertised default
  branch.** It reuses `publishRefOf` from `src/domain/repository.ts`, which is the ref
  `seedHome` proves against. The verdict therefore states that the credential authenticates and may
  push to the repository, and never that a later publish is accepted — the caveat
  `docs/proposal/api/repository.md:69` already carries.

- **Read and write are two verdicts, because they fail independently.** `CredentialVerdict` is a
  discriminated union in which a non-null `refusal` implies `reachable: false`
  (`src/queries/repository/inspect-repository.ts:28-30`). A credential that reads and cannot push
  needs read-true, write-false and a refusal at once, which that union cannot express. The result
  therefore gains a separate member:

  ```ts
  export type AccessVerdict = Readonly<{
    allowed: boolean;
    refusal: GitFailure | null;
  }>;

  access: Readonly<{
    read: AccessVerdict;
    write: AccessVerdict | null;
  }>;
  ```

  `access.read` always mirrors `credential`. `access.write` is `null` when and only when the write
  probe did not run.

- **`requiredAccess` defaults to `"read"`.** `InspectRepositoryInput` gains
  `requiredAccess?: "read" | "write"`. Absent and `"read"` are the same input, and both leave
  `access.write` null. `"write"` runs the probe. The wire schema in `src/http/contract/repository.ts`
  admits the two values and rejects every other string with `400 invalid-request`.

- **A read failure short-circuits the write probe.** When `remoteInfo` fails, the response reports
  `credential.reachable: false`, `access.read.allowed: false` with the same refusal, and
  `access.write` equal to `{ allowed: false, refusal: <the same failure> }` when `requiredAccess` was
  `"write"`. The probe is not attempted, because a credential that cannot read cannot fetch the
  object the probe needs, and reporting `write: null` there would read as "not requested".

- **An empty remote is its own cause.** A remote that advertises no default branch has no object to
  push. `GitFailure` gains one member, `"empty-remote"`, and the probe returns
  `{ allowed: false, refusal: "empty-remote" }` without attempting a fetch. The handoff states
  `credential.refusal` is an open string on the wire and that a new cause is not a breaking change.
  `classifyFailure` never produces the new member; only the probe does.

- **The probe writes no credential material into the configured home.**
  `src/services/git/credential.ts:52-65` writes a credential helper and an ssh key under
  `paths.keyDirectory`, and `paths` is the daemon's configured home. A probe that passed the global
  `paths` to `fetchTracking` and `canPush` would therefore leave credential files outside its own
  temporary directory, and the `finally` block that removes that directory would not remove them.
  `probePush` builds `probePaths = { ...paths, keyDirectory: join(tempDir, "keys"), runDirectory:
join(tempDir, "run") }` and passes that to both calls. `knownHosts` keeps the real path, because the
  probe reads the pinned host keys and never writes them.

- **The probe is skipped for a refused url.** `remoteUrlVerdict` already refuses a disallowed url
  before any network call, and `canPush` throws `url-refused` for a transport mismatch. Both stay
  thrown errors, not verdicts, exactly as they are on the read path.

- **The proposal is amended, not contradicted quietly.** `docs/proposal/api/repository.md:51` states
  the write advertisement is not implementable here. That paragraph is rewritten to state the
  ephemeral-fetch mechanism, its cost, and that `inspect` still seeds no home. The paragraph at
  line 49 gains the two-verdict shape.

## Stories

1. **The git service probes write access.** Add `ProbePushInput` and `probePush` to
   `src/services/git/index.ts`, add `"empty-remote"` to `GitFailure`, and add
   `src/services/git/push-probe.ts` with its test. The name is `push-probe`, because
   `src/services/git/probe.ts` already holds the binary version checker. The implementation makes its own temporary bare
   repository, fetches the branch, resolves the tracking ref, calls `canPush` with the resolved
   object id at `publishRefOf(branch)`, and removes the temporary directory on every exit path.

2. **The query reports two verdicts.** Extend `InspectRepositoryInput` with `requiredAccess` and
   `InspectRepositoryResult` with `access`, and call `probePush` once when the input asks for write.
   Extend `src/queries/repository/inspect-repository.test.ts` with every combination in the coverage
   below.

3. **The contract admits `requiredAccess` and declares `access`.** Extend the request and response
   schemas in `src/http/contract/repository.ts` and their examples. Extend
   `src/http/contract/repository.test.ts`. The existing `credential` member is unchanged.

4. **The handler passes the new field through.** Extend
   `src/http/server/repository/inspect-repository.ts` and its test. The handler parses, calls the one
   query and formats; it branches on no verdict.

5. **The composition root binds the new interface method.** Extend `createBinaryGit` in
   `src/services/git/binary.ts` so `probePush` is reachable, and extend `src/main.test.ts`.
   `src/services/git/binary.test.ts` asserts the exact interface member count and the bytewise-sorted
   member list, so both change with it.

6. **The proposal records the mechanism and the shape.** Amend
   `docs/proposal/api/repository.md` per the Decisions above.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/services/git/push-probe.test.ts \
  src/services/git/preflight.test.ts \
  src/queries/repository/inspect-repository.test.ts \
  src/http/contract/repository.test.ts \
  src/http/contract/registry.test.ts \
  src/http/server/repository/inspect-repository.test.ts \
  src/main.test.ts \
  && echo "PASS EPIC-043"
```

Hermetic coverage required beyond the Proof:

- Every network case runs against the loopback git fixture of EPIC 005. No test reaches a real forge.
- Omitting `requiredAccess` produces a response whose `defaultBranch`, `branches`, `credential` and
  `hostKey` members are deep-equal to the response the same call produces before this epic, and whose
  `access.write` is `null`.
- `requiredAccess: "read"` and an absent `requiredAccess` produce deep-equal responses.
- A credential that reads and may push answers `access.read` deep-equal to
  `{ allowed: true, refusal: null }`, `access.write` deep-equal to `{ allowed: true, refusal: null }`,
  and `credential` deep-equal to `{ reachable: true, refusal: null }`.
- A credential that reads a public remote and may not push answers `credential.reachable: true`,
  `access.read.allowed: true`, and `access.write` deep-equal to
  `{ allowed: false, refusal: "auth-failed" }` or `{ allowed: false, refusal: "permission-denied" }`
  by the exact value the fixture produces. The status is `200`, never `422`.
- A credential that cannot read answers `credential.reachable: false` with its refusal,
  `access.read.allowed: false` with the same refusal, and, for `requiredAccess: "write"`,
  `access.write` carrying that same refusal. The probe records zero fetch invocations in that case.
- A remote advertising no branch answers `access.write` deep-equal to
  `{ allowed: false, refusal: "empty-remote" }`, and the probe records zero fetch invocations.
- `requiredAccess: "push"`, `"Write"` and `""` each answer `400 invalid-request`.
- The temporary directory the probe creates does not exist after a success, after a failed
  advertisement, and after a thrown `GitError`. Each of the three is asserted by the exact path the
  test captures from the runner's `init` invocation, never by counting directories in the process
  temporary root, which races with a parallel test run.
- No file exists under the configured `paths.keyDirectory` after a probe of any outcome. The
  assertion reads that directory, not the probe's own temporary tree.
- The probe creates its temporary directory under its own `mktemp` root and never under the
  configured home, asserted by path prefix.
- No response field, no refusal and no `detail` contains the token, the private key or a raw git
  stderr line. The assertion searches the serialized response for the fixture's secret value.
- `repository.register` behaviour is unchanged: its own preflight still runs, and an
  `auth-failed` from it still maps to `422 credential-rejected`.
