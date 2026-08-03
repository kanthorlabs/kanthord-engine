# EPIC 005 — Test infrastructure — stories

Epic: `.agent/plan/epics/005-test-infrastructure.md`
Prereq: EPIC 004 (sequence order). `test/helpers/` already holds `daemon.ts`, `database.ts`, `home.ts`, `lint.ts`, `ids.ts`, `clock.ts`, `proposal.ts`, `rows.ts`, `cli.ts` and `app.ts`. This epic edits none of them.

A fixture remote serves git smart HTTP on a loopback port, refuses a wrong and a missing token on the `git-receive-pack` advertisement, and proves the phase-1 acceptance rows of `docs/proposal/README.md:82-86` before any test uses it.

## Dispatch order

```
01 → 02
```

- `01` builds the three modules. `02` imports all three, so nothing in `02` compiles first.
- The pair is tight but not one story. `01` owns every HTTP-level assertion, driven with `fetch`. `02` owns every acceptance-list assertion, driven with `isomorphic-git`. The split is what the EPIC's two bullets name, and it keeps a transport defect distinguishable from a library-compatibility defect.

## Stories

- 01 — `node:http` in front of `git http-backend`, the loopback port, the receive-pack Basic-auth check, and the deterministic seeder → `01-fixture-remote.md`
- 02 — the five-row acceptance gate driven through `isomorphic-git` → `02-fixture-acceptance-gate.md`

## Facts (needed for implementation)

State of the tree at the start of this epic:

- `test/helpers/remote/` does not exist. This epic creates it and four modules: `git-binary.ts`, `seed.ts`, `server.ts`, `acceptance.ts`, each with a co-located `.test.ts`.
- `src/services/git/index.ts` holds the `Git` interface and no implementation. This epic imports **nothing** from it. EPIC 006 is the first consumer of the fixture from production-facing code.
- `isomorphic-git@1.40.0` is a declared dependency and is imported nowhere yet. `node:http` and `node:child_process` are builtins. **No new dependency is needed.**
- `.agent/plan/epics/005-test-infrastructure.md:27` fixes the location: the Proof globs `test/helpers/remote/*.test.ts`.

Measured behaviour — each of these changes an assertion:

- `test/helpers/remote/*.ts` already classifies as the `test-helper` element. `boundaries/no-unknown-files` stays silent on a file there, importing `isomorphic-git` is clean, and importing `src/main.ts` still fails `boundaries/dependencies`. **`eslint.config.js` needs no edit.**
- `isomorphic-git` resolves `dir` to `<dir>/.git`. Every call against a bare repository must pass `gitdir`, or it fails with `NotFoundError: Could not find HEAD.` The seeding block at `docs/proposal/phase-1/git-foundation.md:30-38` writes `dir`; that block is prose, not a working call.
- `git http-backend` answers `404` with an empty body unless `GIT_HTTP_EXPORT_ALL=1` is set, or a `git-daemon-export-ok` file exists in the bare repository.
- `git http-backend` serves the `git-receive-pack` **advertisement** without `http.receivepack=true`, because the fixture sets `REMOTE_USER` and git enables `receive-pack` for an authenticated CGI caller. The same fact opens a real push route: measured, an authenticated `git.push` returned `{ ok: true }` and moved `refs/heads/trunk` on the fixture. Story 01 refuses the receive-pack **POST** with `403` in the `node:http` layer, and re-measured, the push then throws `HttpError 403` and the fixture ref is unchanged while all five acceptance rows still pass.
- `git` reads `/etc/gitconfig` and `~/.gitconfig` regardless of a replaced `process.env`. `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` are what satisfy the `AGENTS.md` "no ambient `git` configuration" rule.
- `git --exec-path` is the only reliable way to locate `git-http-backend`. On this machine it is `/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core`, which no fixed path predicts. `git --version` is `git version 2.50.1 (Apple Git-155)`; the fixture records the raw string and asserts no exact version.
- `execFileSync` on an absent binary throws with `code === "ENOENT"`. That is how the gate fails loudly instead of skipping.
- During a `fetch`, `isomorphic-git` sends **no** `Authorization` header even when `onAuth` is supplied. `onAuth` fires only after a `401` challenge. A fetch with a good token, a garbage token and no credential are therefore one code path, and the fixture reproduces a public repository exactly — which is the condition `docs/proposal/open-items.md:15` records and the whole preflight design answers.
- The two refusals raise two different errors. With `onAuth` plus `onAuthFailure: () => ({ cancel: true })`, a wrong token throws `UserCanceledError`. With no `onAuth`, a missing credential throws `HttpError` with `data.statusCode === 401`. Both map to `auth-failed` in EPIC 007.
- `listServerRefs({ forPush: true })` returns **no `HEAD` entry**, even with `symrefs: true`. The receive-pack advertisement carries no `symref` capability. Only the upload-pack advertisement does, as `symref=HEAD:refs/heads/<branch>`.
- `server.close()` alone waits on a keep-alive socket. `server.closeAllConnections()` first, then `close()`, releases the port immediately.
- A commit built with `isomorphic-git` alone is byte-reproducible when the author, the committer, the timestamp and the timezone offset are fixed. With `{ name: "fixture", email: "fixture@kanthord.test", timezoneOffset: 0 }`, timestamp `1577836800 + index * 86400`, and one file `README.md` holding `"hello\n"` with message `"seed\n"`, the oid is `cc9bdf8ea409b56b929085dcbe3d9f3469829565` on every run and in every temporary directory. The two other pinned oids are `df90ef8876916e6130e9bb0c57f3c940cdd75749` (second commit, adds `NOTES.md`) and `3144e4c2055e98d73a7b8e6d590b45fa3b46c9a7` (parentless `rewritten` commit at index 2, which EPIC 006 uses for the non-fast-forward move).

Source facts the stories depend on:

- The acceptance list is the table at `docs/proposal/README.md:82-86`. Phase 1 owns two rows: `HEAD` symref discovery with `fetch`, and a `git-receive-pack` advertisement refusing a wrong token and a missing one. Accepting a push is the phase-2 row.
- The gate runs before any scenario — `docs/proposal/README.md:80`, `docs/proposal/phase-1/README.md:52`.
- The fixture is `node:http` in front of `git http-backend`, with Basic authentication checked **in front of** the CGI — `docs/proposal/README.md:94`, `docs/proposal/open-items.md:13`.
- The credential is HTTP Basic, `{ username, password }` from `onAuth`, never embedded in the url — `docs/proposal/database/provider.md:47`, `docs/proposal/database/repository.md:48`.
- Plain HTTP is legal on a loopback host, as a product rule rather than a test exception — `docs/proposal/phase-1/git-foundation.md:48`.
- The harness moves the fixture by writing to the bare repository directly, so no push route is needed — `docs/proposal/README.md:90`.
- The `git` binary is a test-time prerequisite; the product ships no dependency on it — `docs/proposal/README.md:94`.

## Decisions this epic settled

Nine choices the EPIC and the proposal leave open. Each is pinned in a story, so none reaches build time.

- **The fixture authenticates `git-receive-pack` and nothing else.** The EPIC bullet at `:17` reads "a fixture token it accepts and any other token refused", which taken alone would put the check on every route. `docs/proposal/README.md:85` scopes the refusal to the receive-pack advertisement, and `docs/proposal/open-items.md:15` records the measured public-repository behaviour the preflight design was fixed against. A fixture that refused a bad token on `git-upload-pack` would make the phase-1 registration tests prove the opposite of what the design claims. Story 01 asserts the read side serves an unauthenticated request and a garbage-token request byte-identically.
- **A read-only credential needs no third credential class.** `docs/proposal/phase-1/README.md:49` and `.agent/plan/epics/007-repository-registration.md:19` add "a read-only credential on a public repository" to the wrong-token and missing-token cases. On this fixture that is the same mechanism: any token other than the fixture token is served by upload-pack and refused by receive-pack. Measured — a `read-only` password reaches `getRemoteInfo` successfully and throws `UserCanceledError` on `listServerRefs({ forPush: true })`. EPIC 007 needs no fixture change.
- **The seeder is `isomorphic-git`, and the `git` binary only serves.** Building objects through the binary would need a work tree, a `git commit`, and `GIT_AUTHOR_DATE`-style environment pinning in a child process. Building them with `writeBlob`, `writeTree`, `writeCommit` and `writeRef` needs none of that, produces the same oids, and keeps the binary dependency confined to `git-http-backend`. It also matches `docs/proposal/README.md:90`, which already requires the harness to move the fixture with `isomorphic-git`.
- **A commit oid is an exact asserted value.** The author, committer, timestamp base `1577836800`, daily step and zero timezone offset are constants in `seed.ts`, so `AGENTS.md`'s "a test asserts a value, never some value" holds for git objects. Three oids are pinned in the stories, measured and reproduced across three fresh temporary roots.
- **File order inside a tree is bytewise over the path.** `Buffer.compare` on the UTF-8 names, per the `AGENTS.md` determinism rule. Story 01 asserts that two different key orders in the `files` object produce one oid.
- **The receive-pack POST is refused, and the advertisement is not.** The EPIC non-goal at `:11` says "No push route. Accepting a push is phase 2." Forwarding the POST to the CGI would have shipped a working push route, measured. Refusing it in the `node:http` layer keeps the advertisement — the only thing the phase-1 acceptance row needs — and makes phase 2 a one-branch deletion.
- **The acceptance gate returns rows and never stops early.** Five named rows, always five, always in the fixed order, each carrying `passed` and a `detail`. A thrown check becomes a failed row. `assertFixtureAcceptance` is the throwing wrapper. This shape is a **decision made here**, not a proposal requirement: `docs/proposal/README.md:80` requires each phase to prove its subset before its scenarios run, and says nothing about a diagnostic contract. The reason to run all five is that a gate stopping at row 1 reports one failure where the fixture may have five, and a fixed-length row vector is a value a test compares with `deepStrictEqual`.
- **The two refusals are asserted as two distinct error types.** `UserCanceledError` for a wrong token, `HttpError` with `data.statusCode === 401` for a missing one. An earlier reading would have asserted "it throws", which passes when the fixture refuses for the wrong reason.
- **The request log records `authenticated`, never the header.** `.agent/plan/epics/011-end-to-end-scenarios.md:35` asserts redaction over the fixture Basic-auth header, so the fixture never holds it in readable form. Story 01 asserts `JSON.stringify(remote.requests())` contains neither the token nor `"Basic "`.
- **The token compare is plain equality.** The `AGENTS.md` constant-time rule is scoped to the daemon's bearer token at `docs/proposal/phase-1/transport.md:17`. The fixture models a forge and is not a product surface.

## Open items

Both stories are dispatchable as written. Three items need Ulrich's decision, and they change a document rather than a story.

- B1 - action:YES - pin-the-git-version - `.agent/plan/epics/005-test-infrastructure.md:17` requires the environment to provision `git`, pin its version, and record it. This epic delivers none of that: it accepts any binary named `git` and asserts only that `git --version` returned. Every measured fact in these stories was measured on `git version 2.50.1 (Apple Git-155)`. `/author` may not edit CI or configuration, and the EPIC puts provisioning on the environment, so the gap is escalated rather than absorbed. Decide where the pin lives — a CI tool version, a container base image, or an `engines`-style prerequisite check — and which epic ships it. Until then the suite is reproducible on a developer machine and not pinned across machines.
- S1 - action:YES - amend-the-seeding-block-to-gitdir - `docs/proposal/phase-1/git-foundation.md:30-38` writes `init({ dir: home, bare: true })` and `fetch({ dir: home, ... })`. Against a bare repository those calls fail with `NotFoundError: Could not find HEAD.`; `gitdir` is the working form. The proposal is the source of truth for behaviour, so a call that cannot run should be corrected there rather than carried as a footnote for EPIC 006 to rediscover. The stories already use `gitdir`.
- S2 - action:YES - force-the-gate-before-use - Nothing makes a consumer call `assertFixtureAcceptance`. A later epic can call `startFixtureRemote` directly, skip the gate, and still pass this epic's Proof — which is the failure `docs/proposal/README.md:80` and the EPIC goal say must be impossible. Enforcing it inside EPIC 005 would mean inventing the scenario-facing factory that EPIC 011 owns, so the obligation is recorded here instead: EPIC 006 and EPIC 011 must route fixture construction through a site that runs the gate. Decide whether that becomes an explicit story in EPIC 006 or an EPIC 011 requirement.

Three more are limits that need no amendment.

- S4 - action:NO - phase-1-readme-drops-a-clause - `docs/proposal/phase-1/README.md:52` names the receive-pack row as one "that refuses a wrong token" and omits "and a missing one". `docs/proposal/README.md:85`, `.agent/plan/epics/005-test-infrastructure.md:18` and `:33` all carry both. The stories implement both. The phase-1 restatement is a shorter summary of the same row, not a narrower requirement.
- S5 - action:NO - no-container-packaging-here - `.agent/plan/epics/011-end-to-end-scenarios.md:24` needs the fixture as a single-process container binding a configurable port. `startFixtureRemote` takes an explicit `port`, which is the whole surface EPIC 011 needs. Packaging is EPIC 011's.
- S6 - action:NO - the-parentless-rewrite-commit-stays - `writeFixtureCommit` is exported and its parentless-commit oid is asserted here, although the non-fast-forward move it enables is EPIC 006's. It is not scope creep: `seedRepository` folds over the same function, so the export costs one line, and `docs/proposal/README.md:90` already requires the harness to move the fixture out of band with `isomorphic-git`. Asserting its exact oid is the `AGENTS.md` determinism rule applied to an exported helper, not a test written for a later epic.
