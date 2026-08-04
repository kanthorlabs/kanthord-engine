# EPIC 005 — Test infrastructure — stories

Epic: `.agent/plan/epics/005-test-infrastructure.md`
Prereq: EPIC 004 (sequence order). `test/helpers/` already holds `daemon.ts`,
`database.ts`, `home.ts`, `lint.ts`, `ids.ts`, `clock.ts`, `proposal.ts`,
`rows.ts`, `cli.ts` and `app.ts`.

Two fixture remotes serve a real git transport on loopback ports — one git smart
HTTP with Basic authentication, one `sshd` — over the same byte-reproducible
seeded repository, and neither hands out a handle until its own acceptance list
passes.

## Dispatch order

```
01 → 02 → 03 → 04 → 05
```

- `01` resolves the five binaries and is a prerequisite of everything. Nothing
  compiles without `Tools`.
- `02` needs only `01`. Its object-id literals are the expected values every later
  assertion in the epic compares against.
- `03` and `04` both need `01` and `02` and are independent of each other. Dispatch
  them in parallel if you want; `04` is the higher-risk half.
- `05` is last, because it gates the two factories `03` and `04` provide. `03` and
  `04` each export an **unchecked** `start*` plus their own check list; `05` owns
  the mechanism and the only public entry point. This split is what keeps `05`
  from rewriting `03` and `04`.
- **`03` and `04` must not import `AcceptanceCheck` from `05`'s `acceptance.ts`.**
  Each types its own check list structurally —
  `readonly { name: string; run(subject: X): Promise<void> | void }[]` — and
  TypeScript's structural assignability makes it a valid
  `readonly AcceptanceCheck<X>[]` in `05` with no import. A nominal import would
  make `03` and `04` uncompilable until `05` landed, which would invert this
  dispatch order and make it a lie.

Every file lands under `test/helpers/remote/`, which the Proof globs.

## Stories

- 01 — the five binary paths from configuration, version-probed, never from `PATH` → `01-tool-prerequisites.md`
- 02 — a bare repository built with plumbing under a pinned environment, object ids as literals → `02-fixture-repository-seeding.md`
- 03 — `node:http` in front of `git http-backend`, and the five-row credential matrix → `03-http-fixture-remote.md`
- 04 — unprivileged `sshd` on loopback, two host keys, a generated client key → `04-ssh-fixture-remote.md`
- 05 — the gate that withholds the handle, and the only entry point a consumer imports → `05-fixture-acceptance-gate.md`

## Facts (needed for implementation)

State of the tree at the start of this epic:

- `test/helpers/` has **no** subdirectory today. `test/helpers/remote/` is the
  first one.
- **`test/helpers/remote/` lints clean with no `eslint.config.js` edit.** Verified
  by creating `test/helpers/remote/probe.ts` plus a co-located test and running
  `npx eslint test/helpers/remote/`, which exited 0. `eslint.config.js:56` declares
  `{ type: "test-helper", pattern: "test/helpers", partialMatch: false }` and
  `boundaries/no-unknown-files` is `2`, but the element pattern still classifies a
  nested file, so no rule fires. **Do not amend `eslint.config.js` in this epic.**
- `src/services/git/` holds `index.ts` and no implementation. This epic imports
  nothing from it, per the EPIC non-goal.
- `test/helpers/` files under `test/**/*.ts` may import anything except
  `src/main.ts` — `eslint.config.js:279-301`. No `no-restricted-imports` block
  targets `test/`.
- No file in `src/` or `test/` spawns `git`, `ssh`, `sshd` or `ssh-keyscan` today.
  The only two `spawn` sites are `test/helpers/cli.ts:20-24` and
  `test/helpers/daemon.ts:39-43`, both running `process.execPath`.

Conventions every file in this epic follows:

- `import { describe, it, after } from "node:test";` and
  `import assert from "node:assert/strict";`. `describe`/`it`, never `test`. The
  suite name is the repo-relative path minus the extension, e.g.
  `describe("test/helpers/remote/http.test", ...)`.
- Teardown is the top-level `after()` registered inside each `it`, immediately
  after construction — `test/helpers/home.test.ts:10`. Never `t.after`, never
  `beforeEach`.
- A relative import carries an explicit `.ts` extension
  (`tsconfig.json` sets `allowImportingTsExtensions`).
- `dispose()` uses `fs.rmSync(dir, { recursive: true, force: true })` so a second
  call is a no-op — `test/helpers/home.ts:52-54`.
- Every child process gets `env: {}` plus only the keys it needs. Nothing inherits
  `process.env`, matching the precedent at
  `.agent/plan/stories/001-runtime-foundation/08-harness-helpers.md:87`. `git` is a
  launcher and does need `PATH`, so `PATH` is `tools.execPath` and nothing else.
- A readiness wait has a 5000 ms deadline and throws on it —
  `test/helpers/daemon.ts:72`.

Measured behaviour — each of these changes an assertion, and each was run against
this machine (`git version 2.50.1 (Apple Git-155)`, `OpenSSH_10.2p1`):

- `git-http-backend` is at `` `${git --exec-path}/git-http-backend` `` —
  `/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core/git-http-backend`
  here — and is **not** on `PATH`. `PATH=/usr/bin` is wrong.
- `sshd` is at `/usr/sbin/sshd`, which is not on a normal user `PATH`. This is
  precisely why the paths come from configuration.
- `ssh-keygen` is a **fifth** required tool. Story 04 generates four key pairs with
  it, and `env: {}` means no ambient `PATH` can find it.
- The seeded object ids reproduce byte-identically across two different temporary
  directories. The seven literals are in `02-fixture-repository-seeding.md`.
- A fetch writes `refs/remotes/origin/HEAD` **and** `refs/remotes/origin/main`. An
  assertion expecting exactly one tracking ref fails.
- `--no-tags` leaves `refs/tags/*` empty against the tagged fixture; without it,
  tag auto-follow writes them — `docs/proposal/open-items.md:31`.
- The credential matrix, measured: `info/refs?service=git-upload-pack` is `200`
  with no credential, with a wrong one and with the read-only one.
  `info/refs?service=git-receive-pack` is `401` for all three and `200` only for
  the write-capable credential. The receive-pack body begins
  `001f# service=git-receive-pack\n`.
- The seeded repository needs `http.receivepack=true`, or the backend refuses the
  write advertisement.
- `git-http-backend` writes a `Status:` header only on an error, so a success
  defaults to `200`.
- An **unprivileged** `sshd` serves a real fetch, but only with `StrictModes no`
  and `UsePAM no`, and it authenticates only `os.userInfo().username`. Measured on
  **darwin and on Linux** — Debian 12 in a rootless podman container, `git` 2.39.5,
  `OpenSSH_9.2p1`, as a non-root account. `/run/sshd` is absent there and does not
  matter.
- The seeded object ids are identical on darwin (`git` 2.50.1, arm64 host) and in the
  Debian 12 container (`git` 2.39.5). The literals hold across two `git` versions and
  two platforms, not one installation.
- `git --exec-path` is `/usr/lib/git-core` on Debian and an Xcode path on darwin.
  The two share no prefix, which is why it is always resolved and never hardcoded.
- `ssh://user@127.0.0.1:<port>/abs/path` works with no `-p` in `GIT_SSH_COMMAND`.
- **`ssh-keyscan` output order is not the `-t` order.** `-t ed25519,rsa` returned
  `ssh-rsa` first on three consecutive runs. The fixture sorts host keys bytewise
  by algorithm, giving `ssh-ed25519` before `ssh-rsa`, so EPIC 007 can pin an
  order.
- A mismatched host key fails immediately with
  `REMOTE HOST IDENTIFICATION HAS CHANGED` and prints the offending `SHA256:`
  fingerprint. It does not hang, so the assertion is the message and not a timeout.
- A `0644` key file yields `Permissions 0644 for '<path>' are too open`,
  `bad permissions`, then `Permission denied (publickey)`.
- An unprivileged `sshd` on darwin logs
  `BSM audit: bsm_audit_session_setup: setaudit_addr failed: Operation not permitted`.
  A test must not assert the log is otherwise empty.
- `GIT_CONFIG_GLOBAL=/dev/null` does suppress a hostile `~/.gitconfig`: with a
  hostile `HOME` setting `core.autocrlf = true`, `config --get core.autocrlf` exits
  1 under the pin and prints `true` without it. Both halves are asserted, so the
  pin cannot be vacuous.

Source facts the stories depend on:

- The `deterministic` tier names both transports at `docs/proposal/README.md:78`,
  and it is the only line that names them together. The acceptance table at
  `README.md:82-86` is HTTP-only; the ssh acceptance rows exist only in this EPIC.
- The harness moves the fixture remote by writing to the bare repository directly
  with the `git` binary, so no push route is needed —
  `docs/proposal/README.md:90`. Story 02 exposes `seed.git()` for that.
- A read preflight cannot prove a credential; only the `git-receive-pack`
  advertisement separates a good token from a garbage one —
  `docs/proposal/open-items.md:15`, `docs/proposal/api/repository.md:48-54`. This
  is why Story 03 serves reads to anyone.
- The pinned `git` environment is the fenced block at
  `docs/proposal/phase-1/git-foundation.md:60-70`, and the three extra `-c` flags
  are at `:73`.
- The pinned `GIT_SSH_COMMAND` is
  `docs/proposal/phase-1/git-foundation.md:97-105`.
- `ssh` refuses a key file that is not mode `0600` —
  `docs/proposal/open-items.md:31`, `git-foundation.md:91`.
- The `known_hosts` entry uses the `[host]:port` spelling —
  `docs/proposal/api/repository.md:38`.
- A fixture repository is built with plumbing under the pinned environment, because
  `core.autocrlf`, the file mode bits and a clean filter each change the bytes that
  are hashed — `docs/proposal/phase-1/git-foundation.md:264`.
- The tool contract table is `docs/proposal/open-items.md:44-47`: `git` version
  ranged, `ssh` version recorded, `ssh-keyscan` presence only. Each path comes from
  configuration and resolution never consults an ambient `PATH` — `:49`.
  `ssh-keyscan` has no portable version output — `:51`.

## Decisions this epic settled

Six choices the EPIC and the proposal leave open. Each is pinned in a story so
none reaches build time.

- **Five tools, not four, and `ssh-keygen` is one of them.** Story 04 generates
  four key pairs, and every spawn passes `env: {}`, so an ambient `PATH` cannot find
  `ssh-keygen`. `KANTHORD_TEST_SSH_KEYGEN` defaults to `/usr/bin/ssh-keygen`, and
  Story 01 asserts `Object.keys(tools.paths)` is exactly the five names so a sixth
  binary cannot be spawned without being resolved first.
- **Every finite operation carries a deadline; every long-lived process carries
  an owner.** A finite external command runs with `timeout: 10000`,
  `killSignal: "SIGKILL"` and `maxBuffer: 8 MiB` — every `execFileSync`,
  `spawnSync` and `execFile` in the epic, plus the per-request CGI `spawn`. A
  `node:test` timeout cannot interrupt a synchronous `execFileSync` blocked in a
  child, so without this a hung `ssh` hangs the suite instead of failing it, and
  the EPIC's "names the mismatch rather than timing out" coverage line would be
  unprovable. `maxBuffer` is not a `spawn` option and is never passed to one.

  A long-lived process — the `sshd` fixture is the only one — carries no lifetime
  timeout, because `spawn`'s `timeout` caps total life rather than idle time and
  would SIGKILL a healthy server mid-test. It is bounded instead by four things:
  a startup deadline, an owner that registers cleanup before the handle can
  escape, a bounded shutdown that escalates SIGTERM to SIGKILL and always
  settles, and an emergency kill when the runner exits.

- **The seeded repository pins `--object-format=sha1`.** Every literal is a
  40-character SHA-1 id, and a `git` whose default is SHA-256 (built that way, or
  via `GIT_DEFAULT_HASH`) would invalidate all seven at once. `GIT_DEFAULT_HASH` is
  also absent from `pinnedGitEnvironment`, and Story 02 asserts the ids hold even
  when `GIT_DEFAULT_HASH=sha256` is injected.
- **The ssh fixture pins the server-side `git` too.** An ssh git request runs
  `git-upload-pack` on the **server** side, in a session whose `PATH` is `sshd`'s
  default. `sshd_config` therefore carries `SetEnv PATH=<tools.execPath>`, and Story
  04 asserts the directive is present. Without it, Story 01's version probe would
  not cover the binary that actually serves the ssh fixture.
- **`GIT_SSH_COMMAND` is single-quoted per path.**
  `docs/proposal/phase-1/git-foundation.md:105` requires it, and both `TMPDIR` and a
  tool override are caller controlled, so a space in either would break the command
  in an environment-dependent way. A path containing a single quote is refused.
- **The tool paths come from test-side environment variables, not from the product
  config service.** The EPIC non-goal is "No product code", and
  `.agent/plan/epics/007.5-startup-recovery.md:22` owns adding `tools.git`,
  `tools.ssh` and `tools.sshKeyscan` to the convict schema. So Story 01 reads
  `KANTHORD_TEST_GIT`, `KANTHORD_TEST_SSH`, `KANTHORD_TEST_SSHD` and
  `KANTHORD_TEST_SSH_KEYSCAN`, each with a documented absolute default, and touches
  no file under `src/`. It **supplies** what the EPIC 006 injection contract at
  `.agent/plan/epics/006-git-primitives.md:17` needs. State it that way and not more:
  `Tools.paths` is not the record the runner takes. EPIC 006's `GitPaths` names three
  binaries — `git`, `ssh`, `sshKeyscan` — plus four daemon-owned directories, and
  `.agent/plan/stories/006-git-primitives/01-pinned-invocation.md` maps the three by
  name and forbids spreading `Tools.paths` into it, because `sshd` lives in
  `/usr/sbin` and a spread would widen the pinned child `PATH`. The two records are a
  superset and a selection, not one contract. `sshd` and
  `ssh-keygen` are fixture-only tools and correctly have no home in the production
  `Settings` type; `open-items.md:44-47` lists three tools, not five.

  State the conclusion narrowly. This mechanism does **not** satisfy
  `open-items.md:49`, whose subject is the daemon's own start-up contract — a test
  helper is not the daemon, and EPIC 007.5 is what will satisfy that line. What it
  does is hold the same property on the test side: a documented default, an absolute
  path, and no ambient lookup.

- **Absence throws, and no test is ever skipped.** `resolveTools` returns a total
  record or raises `ToolError`. There is no nullable tool, no boolean guard and no
  `t.skip` anywhere in the epic, so a missing binary fails the suite loudly.
- **The gate lives in the factory, and a grep assertion is what makes it
  structural.** Story 03 and Story 04 export `startHttpRemote` / `startSshRemote`
  plus their own check lists; Story 05's `index.ts` is the only public entry point
  and never re-exports the starters. A `before` hook or a separate gate test file
  would both depend on file order, which `node --test` does not guarantee, so the
  factory is the right home.

  But omitting a name from a barrel is **not** enforcement: TypeScript has no
  module privacy, so `import { startHttpRemote } from "./http.ts"` still compiles.
  The epic's "structural rather than conventional" requirement is therefore carried
  by a **grep assertion** in `index.test.ts` — no file under `src/` or `test/` other
  than the five named fixture files may mention either starter. That is this
  repository's own mechanism for a rule the type system cannot express, per the
  `AGENTS.md` enforcement table. Do not claim the barrel alone is structural.

- **The seed has exactly one owner.** A single-transport factory creates the seed
  and its handle's `dispose()` releases it; `createRemotes()` owns the shared seed
  and no per-transport `dispose` touches it, because disposing one transport would
  otherwise invalidate the other. The starters never dispose a seed they did not
  create. Story 05 asserts both halves, because the obvious caller would otherwise
  leak one temporary directory per test.
- **A missing tool is asserted against the factory, not only against
  `resolveTools`.** `createHttpRemote` and `createSshRemote` take an optional `env`
  passed straight to `resolveTools`, so the EPIC coverage line "fails loudly when a
  required tool is absent" is proved where the gate lives, hermetically, without
  mutating `process.env`.
- **Host keys are sorted bytewise by algorithm, and `ssh-keyscan` order is never
  asserted.** Measured: the scan returned `ssh-rsa` before `ssh-ed25519` on three
  runs regardless of the `-t` order, so the order is the server's negotiation
  order. The fixture publishes a sorted list, and Story 04 asserts the _sorted_
  scan matches it. `.agent/plan/epics/007-repository-registration.md:46` needs a
  reproducible ordered list and gets one.
- **The fixture serves reads to anyone.** Anonymous, wrong-credential and
  read-only requests all receive the `git-upload-pack` advertisement, exactly as
  the public repository in the spike at `docs/proposal/open-items.md:15` did. This
  is not laxity: reproducing it is the only way the read-only-credential case of
  `.agent/plan/epics/007-repository-registration.md:49` can exist to be caught by
  the write-advertisement preflight.
- **`runAcceptance` runs every check and reports all failures.** Sequential, in
  array order, collecting rather than short-circuiting, so one run names the whole
  broken list instead of one row at a time. An empty check list is itself a
  failure, because an empty list would pass and gate nothing.

## Open items

Six items. **Ulrich settled S1 and S5. Nothing awaits a decision.**

- S1 - **ratified by Ulrich** - minimum-git-version -
  `docs/proposal/open-items.md:53` defers the supported `git` floor to "a release
  decision", and no file under `docs/proposal/` names a version. Story 01 pins
  `minimumGitVersion = "2.34.0"`, and Ulrich ratified it as **"ok for now"** — a
  working floor rather than the settled release contract, so `docs/proposal/` stays
  unamended until it is one. Do not justify the number by the flag set: `--no-tags`,
  `--no-hardlinks`, `--initial-branch`, `mktag` and `-c protocol.allow` all predate
  2.34, so the flags imply a much lower floor. The floor is one exported constant
  asserted in one place, so revising it is a one-line edit. Corroboration: the Debian
  12 container that closed S5 ships `git` 2.39.5, which clears the floor.
  Note the narrower scope: Story 01 **records** the version it ran against and
  refuses one below the floor. It does not deliver the enumerated tested set of
  `open-items.md:61-63` — minimum, shipped-image, newest tested — which is a
  continuous-integration matrix and not something a `node:test` run can pin.
- S5 - **closed by Ulrich, and proved** - unprivileged-sshd-on-linux - Ulrich's
  criterion was "test on podman container is ok, if podman works, it passes". Podman
  6.0.0 rootless works here, and the ssh fixture was re-run inside a Debian 12
  bookworm container (`git` 2.39.5, `OpenSSH_9.2p1`) as a non-root `useradd`
  account. **It passed every item**: unprivileged `sshd` started and served an
  authenticated fetch, the mismatched host key was refused with
  `REMOTE HOST IDENTIFICATION HAS CHANGED`, the `0644` key was refused, the keyscan
  order was again unstable, and the seeded object ids came out **identical to the
  darwin literals** on a different `git` version and a different architecture.
  The Linux hazard raised against the plan did not materialise: `/run/sshd` does not
  exist in the container and does not matter, because the privilege-separation
  directory is needed by a root `sshd` and not by this one.
  **No podman dependency enters EPIC 005.** The container run is the evidence that
  closed this item, not a step in the gate: the Proof stays
  `node --test test/helpers/remote/*.test.ts`, and
  `.agent/plan/epics/011-end-to-end-scenarios.md:32` keeps ownership of podman as a
  provisioned prerequisite. Say so if a standing podman gate inside this epic was the
  intent instead.
- S2 - action:NO - ssh-fixture-acceptance-rows-are-not-in-the-proposal - The
  acceptance table at `docs/proposal/README.md:82-86` is HTTP-only, and the two ssh
  rows plus the `0600` row come from `.agent/plan/epics/005-test-infrastructure.md:22`
  alone. The `0600` row also tests the local `ssh` **client**, not the `sshd`
  fixture. Both are implemented as written; the observation is that the proposal
  table is narrower than the EPIC, not that either is wrong. Widening the table is
  optional and changes no code.
- S3 - action:NO - the-scan-timeout-case-belongs-to-epic-007 -
  `.agent/plan/epics/007-repository-registration.md:46` needs a scan that times
  out. This epic builds no timeout seam: EPIC 007 scans a closed loopback port,
  which needs nothing from the fixture. Adding a hang mode here would be a
  speculative feature.
- S4 - action:NO - the-fixture-hashes-of-epic-011 - `.agent/plan/epics/011-end-to-end-scenarios.md:19`
  requires the evidence bundle to record "the fixture hashes". `fixtureObjectIds`
  and `SeededRepository.refs` are exactly that, exported from Story 02. EPIC 011
  reads them; no extra surface is needed here.
- S6 - action:NO - readme-parity-is-prose-not-a-registry - The parity assertion of
  Story 05 compares `fixtureTransports` against a hand-declared evidence table, in
  both directions, plus a closed keyword vocabulary that fails when the tier names a
  third transport. That is the strongest available oracle, and it is weaker than the
  registry parity of EPIC 004: `docs/proposal/README.md:78` is one English sentence
  with no machine-readable transport list. Adding a parseable marker to the proposal
  would close the gap and is a documentation change, not a story. Do not describe the
  assertion as structural parity.

## Note on the working tree

At authoring time the tree carried uncommitted EPIC 004 Story 05 work —
`src/http/contract/errors.ts`, `src/http/contract/errors.test.ts`,
`src/http/server/envelope.ts`, `src/http/server/envelope.test.ts`, and two
modified `.agent/tdd/memory/` files. This epic touches none of them.
