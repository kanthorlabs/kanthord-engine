# EPIC 043 — `repository.inspect` reports write access — stories

Epic: `.agents/plan/epics/043-repository-inspect-reports-write-access.md`
Prereq: EPIC 042 (sequence order).

`repository.inspect` gains `requiredAccess: "write"`, which runs an ephemeral fetch-and-dry-push probe and reports read and write as two independent `AccessVerdict` members.

## Dispatch order

1. **Story 1** — foundation; Stories 2, 3, 5 depend on it.
2. **Stories 2, 3, 5** — parallel after Story 1.
   - Story 2 adds query logic and needs the `probePush` interface method from Story 1.
   - Story 3 adds the contract schema and is independent of Story 2.
   - Story 5 wires `binary.ts` and needs `push-probe.ts` from Story 1.
3. **Story 4** — after Stories 2 and 3 (handler uses both the query type and the contract schema).
4. **Story 6** — independent; run any time after Stories 1–5 are stable.

## Stories

- 1 — git service adds `probePush` interface method, `"empty-remote"` failure, and `push-probe.ts` → `01-git-service-probes-write-access.md`
- 2 — query adds `requiredAccess`, `AccessVerdict`, `access` member, and calls `probePush` → `02-query-reports-two-verdicts.md`
- 3 — contract extends request schema with `requiredAccess`, response with `access`; creates `repository.test.ts` → `03-contract-admits-required-access.md`
- 4 — handler destructures `requiredAccess`, forwards it to the query, includes `access` in the response body → `04-handler-passes-field-through.md`
- 5 — `binary.ts` adds `probePush` entry; `main.test.ts` fixture sends `requiredAccess: "write"` → `05-composition-root-binds-probe-push.md`
- 6 — `docs/proposal/api/repository.md` rewritten to describe the ephemeral probe and two-verdict shape → `06-proposal-records-mechanism.md`

## Facts (needed for implementation)

- **Git implementation assembler**: `src/services/git/binary.ts` (NOT `cli.ts`). Factory function `createBinaryGit` at lines 23–46. The epic's story 5 guess of `cli.ts` is wrong; cite `binary.ts` instead.
- **`GitFailure` union**: `src/services/git/index.ts:87–97`. New member `"empty-remote"` appended after `"unknown"`.
- **`Git` interface**: `src/services/git/index.ts:150–185`. `probePush` inserted after `canPush` (line 163).
- **`PushPreflight`**: `src/services/git/index.ts:130–132` — `{ allowed: true }` or `{ allowed: false; failure: GitFailure; detail: string }`.
- **`ProbePushInput`**: new type added to `src/services/git/index.ts` after `PushPreflight` — `{ remoteUrl: string; branch: string | null; credential: GitCredential }`.
- **`probe.ts` is taken**: `src/services/git/probe.ts` (237 lines) is the binary/tool version probe. The new push-probe file must be named `push-probe.ts`.
- **Seed pattern** (`src/services/git/seed.ts:77–170`): `git init --bare --template= --object-format=sha1 --initial-branch=<branch>` → `remote add origin` → `config remote.origin.fetch TRACKING_REFSPEC` → `fetchTracking` → `resolveRef(trackingRefOf(branch))` → `canPush`. `push-probe.ts` replicates this sequence in a temp dir.
- **`TRACKING_REFSPEC`**: `src/services/git/index.ts:187` — `"+refs/heads/*:refs/remotes/origin/*"`.
- **`trackingRefOf`**: `src/domain/repository.ts:59` — `refs/remotes/origin/${branch}`.
- **`publishRefOf`**: `src/domain/repository.ts:64` — alias of `headRefOf` → `refs/heads/${branch}`.
- **Loopback fixture**: `test/helpers/remote/index.ts` — `createHttpRemote()`. Writer credential can push; reader credential cannot. `httpRemote.credentials.wrongCredential` triggers `auth-failed` on fetch.
- **`src/http/contract/repository.test.ts` does not exist** today. Story 3 creates it from scratch.
- **`InspectRepositoryDependencies`**: `src/queries/repository/inspect-repository.ts:17–21` — `{ storage, crypto, git }`. `git: Git` is already present; Story 2 calls `dependencies.git.probePush` without adding a new dependency.
- **`canPush` throws, not returns, on URL refusal**: `src/services/git/preflight.ts:26–66`. The `finally` block in `push-probe.ts` cleans the temp dir even on a throw.
- **Probe OID source**: `fetchTracking` populates the tracking ref; `resolveRef(trackingRefOf(branch))` reads it. The OID at `trackingRefOf(branch)` after fetch is `proposedOid` for `canPush`.
