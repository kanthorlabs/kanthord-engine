# EPIC 005 — Test infrastructure

Status: **draft**.

## Goal

A fixture remote serves git smart HTTP on a loopback port and passes its own phase-1 acceptance list before any test uses it. `isomorphic-git` has no transport that reads a local path as a remote, so every git test needs this.

## Non-goals

- No push route. Accepting a push is phase 2.
- No evidence bundle. EPIC 011 owns it.
- No harness helpers. EPIC 001 owns the temporary home, the temporary-database convention and the teardown, because EPIC 003 and EPIC 004 build on them before this epic opens.

## Stories

- **Fixture remote** — `node:http` in front of `git http-backend`, on a loopback port, with a fixture token it accepts and any other token refused. It lives under `test/helpers/`, because the AGENTS.md import matrix lets a test import shared support from there and from nowhere else. The `git` binary is a test-time prerequisite: the environment provisions it, pins its version, and the version is recorded.
- **Fixture acceptance gate** — `HEAD` symref discovery, `fetch`, and a `git-receive-pack` advertisement that refuses a wrong token and a missing one. The gate runs before any scenario, because a fixture that fails an item makes every test that uses it prove less than it claims.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test test/helpers/remote/*.test.ts && echo "PASS EPIC-005"
```

Hermetic coverage required beyond the Proof:

- The acceptance gate fails loudly when the `git` binary is absent, rather than skipping.
- The receive-pack advertisement answers `401` with no credential and with a wrong one, and it changes nothing on the fixture.
