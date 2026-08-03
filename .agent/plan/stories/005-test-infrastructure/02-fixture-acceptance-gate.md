# Story 02 — Fixture acceptance gate

Epic: `.agent/plan/epics/005-test-infrastructure.md`
Depends on: Story 01 (`test/helpers/remote/server.ts`, `test/helpers/remote/seed.ts`, `test/helpers/remote/git-binary.ts`).

One module and one test. The module drives `isomorphic-git` against a running fixture and proves the phase-1 rows of the acceptance list at `docs/proposal/README.md:82-86`. Story 01 proves the fixture answers HTTP; this story proves the library the product uses accepts those answers.

## Change

### 1. `test/helpers/remote/acceptance.ts` (new)

```ts
export type AcceptanceRow = Readonly<{
  name: string;
  passed: boolean;
  detail: string;
}>;

export type FixtureAcceptanceInput = Readonly<{
  remote: FixtureRemote;
  repository: string;
  branch: string;
  headOid: string;
}>;

export class FixtureAcceptanceError extends Error {
  readonly rows: readonly AcceptanceRow[];
}

export function checkFixtureAcceptance(
  input: FixtureAcceptanceInput,
): Promise<readonly AcceptanceRow[]>;

export function assertFixtureAcceptance(
  input: FixtureAcceptanceInput,
): Promise<void>;
```

`checkFixtureAcceptance` runs the five checks below **in this order** and returns one row each, always five rows, always in this order. A check never throws out of the function; a thrown error becomes `passed: false` with the error name and message as `detail`. `assertFixtureAcceptance` calls it and throws `FixtureAcceptanceError` when any row has `passed: false`, with `rows` set and a message listing every failed `name` **and `remote.gitVersion`**. Every measured behaviour in this epic depends on the serving `git`, so a gate failure that does not name the version sends a reader to the wrong cause. This is the one place the version is recorded in this epic; see B1 in the index.

The order is fixed so the row array is a deterministic value a test compares with `deepStrictEqual`.

Let `url` be `` `${remote.url}/${repository}` `` and `onAuth` be `() => ({ username: remote.username, password: remote.token })`.

1. **`head-symref`** — `getRemoteInfo({ http, url })`, with no `onAuth`. Passes when `info.HEAD` equals `` `refs/heads/${branch}` `` and `info.refs.heads[branch]` equals `headOid`. `detail` is `info.HEAD`.
2. **`fetch-tracking`** — create a scratch bare gitdir, run the seeding sequence, and pass when the tracking ref carries `headOid` and no `refs/heads/*` ref exists. Steps:
   - `init({ fs, bare: true, gitdir })`
   - `addRemote({ fs, gitdir, remote: "origin", url })`
   - `setConfig({ fs, gitdir, path: "remote.origin.fetch", value: "+refs/heads/*:refs/remotes/origin/*" })`
   - `fetch({ fs, http, gitdir, remote: "origin", prune: true, onAuth })`
   - `resolveRef({ fs, gitdir, ref: `refs/remotes/origin/${branch}` })` equals `headOid`
   - `listBranches({ fs, gitdir })` deep-equals `[]`

   `detail` is the resolved tracking oid.

   The scratch gitdir is `join(fs.mkdtempSync(join(tmpdir(), "kanthord-gate-")), "probe.git")`, made fresh on every call and removed in a `finally` that runs whether the check passed, failed or threw. It is **never** placed under `remote.root`. `remote.root` is `GIT_PROJECT_ROOT`, so a probe repository there would be served by the fixture under test, and a second call would find the tracking ref already populated by the first and pass without fetching anything.

3. **`receive-pack-good-token`** — `listServerRefs({ http, url, forPush: true, onAuth })`. Passes when the result contains an entry whose `ref` is `` `refs/heads/${branch}` `` and whose `oid` is `headOid`. `detail` is the entry count as a string.
4. **`receive-pack-wrong-token`** — `listServerRefs({ http, url, forPush: true, onAuth: () => ({ username: remote.username, password: wrongToken }), onAuthFailure: () => ({ cancel: true }) })`. Passes when it throws and `error.name` is `"UserCanceledError"`. `detail` is `error.name`.

   `wrongToken` is `` `not-${remote.token}` ``, derived rather than literal. A hard-coded `"wrong-token"` is a legal value of `remote.token`, and a fixture configured with it would make this row pass while the fixture accepted the credential.

5. **`receive-pack-no-credential`** — `listServerRefs({ http, url, forPush: true })`, with no `onAuth` at all. Passes when it throws, `error.name` is `"HttpError"`, and `error.data.statusCode` is `401`. `detail` is `` `${error.name} ${error.data?.statusCode}` ``.

Rows 4 and 5 report two **different** error types, and the story pins both. Measured: with `onAuth` supplied, `isomorphic-git` answers the `401` challenge, the fixture refuses the credential, `onAuthFailure` returns `{ cancel: true }`, and the library throws `UserCanceledError`. With no `onAuth`, the library cannot answer the challenge and surfaces the transport error as `HttpError` with `data.statusCode` `401`. `docs/proposal/database/repository.md:42-46` fixes the `{ cancel: true }` behaviour, and EPIC 007 maps both to `auth-failed`.

`fetch` and `getRemoteInfo` take `gitdir`, never `dir` — see Story 01.

## Constraints

- Run every check. Never return early on the first failure. A gate that stops at row 1 hides rows 2 to 5, and `docs/proposal/README.md:80` requires each phase to prove its **subset** before its scenarios run.
- Never call `test.skip`, and never read an environment variable to decide whether to run. `.agent/plan/epics/005-test-infrastructure.md:32` requires an absent `git` binary to fail loudly, and Story 01 makes `startFixtureRemote` reject before this module is reached.
- Assert no push. `listServerRefs({ forPush: true })` reads the advertisement and writes nothing — `docs/proposal/api/repository.md:28`.
- Add no dependency, and edit no file outside `test/helpers/remote/`.

## Verify

`node --test test/helpers/remote/acceptance.test.ts` — new file, suite `"test/helpers/remote/acceptance.test"`. Each test seeds its own root and closes the fixture in `after` before removing the directory.

The shared fixture for this file: root from `fs.mkdtempSync(join(tmpdir(), "kanthord-remote-"))`, `seedRepository({ root, name: "origin.git", branch: "trunk", commits: [{ message: "seed", files: { "README.md": "hello\n" } }] })`, so `headOid` is `"cc9bdf8ea409b56b929085dcbe3d9f3469829565"`.

- `checkFixtureAcceptance` on that fixture returns exactly five rows, and `rows.map((row) => row.name)` deep-equals `["head-symref", "fetch-tracking", "receive-pack-good-token", "receive-pack-wrong-token", "receive-pack-no-credential"]`.
- Every row has `passed: true`. Assert `rows.filter((row) => !row.passed)` deep-equals `[]`, so a failure names itself in the diff.
- Row `head-symref` has `detail` exactly `"refs/heads/trunk"`.
- Row `fetch-tracking` has `detail` exactly `"cc9bdf8ea409b56b929085dcbe3d9f3469829565"`.
- Row `receive-pack-wrong-token` has `detail` exactly `"UserCanceledError"`.
- Row `receive-pack-no-credential` has `detail` exactly `"HttpError 401"`.
- `assertFixtureAcceptance` on that fixture resolves and returns `undefined`.
- The gate changes nothing on the fixture. Write a local `snapshot(gitdir)` helper in the test file: walk `<gitdir>` recursively, and for every file produce `` `${relativePath} ${size} ${sha256Hex}` ``, sorted bytewise with `Buffer.compare`. Assert `snapshot` before and after `checkFixtureAcceptance` are deep-equal. A ref listing plus an `objects/` **name** listing would miss a modified existing object, a changed `packed-refs`, a config edit, and a mutation that was restored — this catches all of them. `.agent/plan/epics/005-test-infrastructure.md:33` requires the refusals to change nothing on the fixture.
- Each refusal separately changes nothing, and neither refusal reaches the CGI. Snapshot the fixture, drive **only** the wrong-token advertisement, and assert the snapshot is unchanged. Repeat for the no-credential advertisement. Then assert `remote.requests()` records both with status `401` — Story 01 makes a `401` return before the backend spawns, so a recorded `401` is the proof the CGI never ran.
- The `403` push refusal is out of this gate's five rows and belongs to Story 01. Row order and count do not change.
- The gate reports a failure rather than throwing out of `checkFixtureAcceptance`: run it with `branch: "absent"` and assert five rows are still returned, `rows[0].passed` is `false`, and `rows[0].name` is still `"head-symref"`.
- The gate does not stop at the first failure: in that same run, `receive-pack-no-credential` still has `passed: true`. Every check ran.
- `assertFixtureAcceptance` with `branch: "absent"` rejects with `FixtureAcceptanceError`, its `rows` has length five, and its message contains `"head-symref"` and `remote.gitVersion`.
- A wrong `headOid` fails the three rows that compare an oid and passes the two that only require a refusal. Pass `headOid: "0".repeat(40)` and assert `rows.map((row) => row.passed)` deep-equals `[false, false, false, true, true]`. Row 3 `receive-pack-good-token` compares the advertised oid against `headOid`, so it fails too — rows 4 and 5 are the only ones that never read `headOid`.
- The fixture token is the one that works: `startFixtureRemote({ root, token: "another-token" })` and the same call still returns all five rows passing, because the gate reads `remote.token`. A gate hard-coding `"fixture-token"` fails this test.
- The wrong token is derived, not literal: `startFixtureRemote({ root, token: "wrong-token" })` and assert all five rows still pass. A gate whose row 4 sends the literal `"wrong-token"` reports a pass here while the fixture accepted the credential, so this is the case that catches it.
- A non-default branch passes: seed `beta.git` on `main` and assert all five rows pass with `repository: "beta.git"`, `branch: "main"`.

`npm run verify` exits 0.

Proof: completes `node --test test/helpers/remote/*.test.ts && echo "PASS EPIC-005"`.
