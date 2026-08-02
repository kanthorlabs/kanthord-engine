# EPIC 005 — Test infrastructure

Status: **draft**.

## Goal

A fixture remote serves git smart HTTP on a loopback port and passes its own phase-1 acceptance list before any test uses it. `isomorphic-git` has no transport that reads a local path as a remote, so every git test needs this.

## Non-goals

- No push route. Accepting a push is phase 2.
- No evidence bundle. EPIC 010 owns it.

## Stories

- **Fixture remote** — `node:http` in front of `git http-backend`, on a loopback port, with a fixture token it accepts and any other token refused. The `git` binary is a test-time prerequisite: the environment provisions it, pins its version, and the version is recorded.
- **Fixture acceptance gate** — `HEAD` symref discovery, `fetch`, and a `git-receive-pack` advertisement that refuses a wrong token and a missing one. The gate runs before any scenario, because a fixture that fails an item makes every test that uses it prove less than it claims.
- **Harness helpers** — a temporary daemon home, a temporary database, a supertest application factory, and the teardown that releases the home lock.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test test/fixtures/remote/*.test.ts && echo "PASS EPIC-005"
```

Hermetic coverage required beyond the Proof:

- The acceptance gate fails loudly when the `git` binary is absent, rather than skipping.
- The receive-pack advertisement answers `401` with no credential and with a wrong one, and it changes nothing on the fixture.
