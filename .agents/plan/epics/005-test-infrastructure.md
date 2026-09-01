# EPIC 005 — Test infrastructure

Status: **ready**.

## Goal

Two fixture remotes serve a real git transport on loopback ports, and each passes its own phase-1 acceptance list before any test uses it. One speaks git smart HTTP with Basic authentication; the other speaks ssh. `docs/proposal/README.md` makes both a condition of the `deterministic` tier, because the product supports both transports and an untested transport is a claim rather than a feature.

## Non-goals

- No push route. Accepting a push is phase 2.
- No evidence bundle. EPIC 011 owns it.
- No harness helpers. EPIC 001 owns the temporary home, the temporary-database convention and the teardown, because EPIC 003 and EPIC 004 build on them before this epic opens.
- No product code. This epic imports nothing from `src/services/git/`, which holds an interface and no implementation until EPIC 006.

## Stories

- **Tool prerequisites** — resolve and version-probe `git`, and resolve `sshd`, `ssh` and `ssh-keyscan`, from configuration rather than an ambient `PATH`. A missing tool fails the suite loudly and never skips a test. The versions are recorded, because `docs/proposal/open-items.md` makes the tested set an enumerated release artifact rather than an open range.
- **Fixture repository seeding** — build a bare repository with `git` plumbing under a pinned environment, so an object id is reproducible. The author, the committer, the timestamps and the timezone are fixed, and the resulting object ids are asserted exactly. `core.autocrlf`, the file mode bits and any filter are pinned, because each one changes the bytes that are hashed.
- **HTTP fixture remote** — `node:http` in front of `git http-backend`, on a loopback port. It serves the credential matrix EPIC 007 needs, not one token: anonymous read allowed, a read-only credential that fetches but is refused by `git-receive-pack`, a write-capable credential, a wrong credential and a missing one. A read-only credential that reads exactly like a good one is the case that motivated the write-advertisement preflight, so the fixture has to be able to produce it. It lives under `test/helpers/`, because the AGENTS.md import matrix lets a test import shared support from there and from nowhere else.
- **ssh fixture remote** — `sshd` on a loopback port with a generated host key and a generated client key, serving the same seeded repositories. It runs from a generated config with no operator configuration in scope, and it publishes its host key so a test can pin it and can also present a wrong one.
- **Fixture acceptance gate** — the factory withholds the fixture handle until its own acceptance list passes, so a consumer cannot reach an unchecked fixture by running first. Ordering between test files is not a guarantee, and this makes the check structural rather than conventional. Both fixtures prove their own list before a scenario uses them. HTTP proves `HEAD` symref discovery, a fetch, and a `git-receive-pack` advertisement that refuses a wrong token and a missing one. ssh proves a key-authenticated fetch, a refusal under a mismatched host key, and a refusal of a key file that is not mode `0600`. A fixture that fails an item makes every test that uses it prove less than it claims.

## Verification Gate

Gates: `npm run verify`

Proof:

```bash
node --test test/helpers/remote/*.test.ts && echo "PASS EPIC-005"
```

Hermetic coverage required beyond the Proof:

- The acceptance gate fails loudly when a required tool is absent, rather than skipping.
- The receive-pack advertisement answers `401` with no credential and with a wrong one, and it changes nothing on the fixture.
- A fetch over the HTTP fixture writes `refs/remotes/origin/*` and no `refs/heads/*`, and `--no-tags` leaves `refs/tags/*` empty against a tagged fixture repository.
- The seeded object ids are asserted as exact literals, and they are identical on a second run in a different temporary directory.
- The ssh fixture refuses a connection whose pinned host key does not match, and the failure names the mismatch rather than timing out.
- A consumer that asks for a fixture whose acceptance list fails receives an error instead of a handle, asserted by forcing one row to fail.
- The `deterministic` tier of `docs/proposal/README.md` names both transports, and a test asserts the fixture set matches that list rather than drifting from it.
- Neither fixture reads the operator's `~/.gitconfig`, `~/.ssh/config` or ssh agent. A test asserts this by setting a hostile value in a temporary `HOME` and observing that it does not take effect.
