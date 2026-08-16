# Story 1 — The proposal states the policy

Epic: `.agent/plan/epics/023-version-compatibility-policy.md`

This story is **independently green**. It edits three markdown files and no code.

## Change

### `docs/proposal/api/README.md`

The `## Versioning` section is `:44-46`. Line `:46` reads:

```
Every path starts with `/v1`. The CLI runs on a second machine, so a client can be older than the daemon. A client sends `X-Kanthord-Client: <version>`, and the daemon reports its own version on `/v1/status`. The daemon serves one version at a time.
```

Replace that one line with the following body. Keep the `## Versioning` heading, and change no other section.

```
Every path starts with `/v1`. The daemon serves one version at a time. **`/v1` is the compatibility contract, and the package version is not.** The package version describes a build, because one repository ships the daemon and the CLI.

Inside `/v1` the daemon may:

- add a response field;
- add a member to an enum;
- add an optional request field;
- add an operation.

Inside `/v1` the daemon may never:

- remove or rename a response field;
- change the type of a response field;
- remove a member from an enum;
- add a required request field;
- change what an error code means, or the status a code maps to.

The list is closed. A change outside it is a `/v2`, and this product has no `/v2`.

**A client must ignore an unknown response field, and it must tolerate an unknown enum member.** A client that refuses either is a client this policy cannot serve.

An older client against a newer daemon always works, so there is no minimum client version and no `mustUpgrade` field. The one real skew is a newer client against an older daemon, and the client asks about it by name: `GET /v1/health` returns `version` and `capabilities`, and a client reads `capabilities` instead of comparing two version strings.

A client sends `X-Kanthord-Client: <version>`. **The daemon never reads that header.** No response body varies by it, no route declares `Vary: X-Kanthord-Client`, and an absent, malformed, prerelease or future-dated value changes nothing. The header is a diagnostic in an operator's log.
```

### `docs/proposal/api/system.md`

Two edits inside the `## system.health` section, and nothing else in the file.

1. The `json` fence at `:20-28` gains the two members. Replace the fence body with:

```json
{
  "status": "degraded",
  "version": "27.8.1",
  "capabilities": ["external-drive", "per-node-write", "project-graph"],
  "dependencies": [
    { "name": "storage", "status": "ok" },
    { "name": "git", "status": "failed" }
  ]
}
```

2. Line `:40` reads:

```
The daemon version, the bind address and the process start time are on `system.status`, which reports what the daemon _is_ rather than whether it is well.
```

Replace it with these two paragraphs:

```
`version` is the daemon build string. `capabilities` names the product abilities this daemon serves, sorted bytewise, and a name appears only when every operation it covers is routed. A client renders a feature on the presence of a name, never on a version comparison. The list is additive, so a client written against an older list ignores a newer name. It is not a route directory: a client that asks whether one route exists calls it and reads `404` or `501`.

The bind address and the process start time are on `system.status`, which reports what the daemon _is_ rather than whether it is well. `capabilities` is on `system.health` only, and not on `system.status`, because `system.health` is the one of the two a `harness` actor reaches. A value in two places is a value that drifts.
```

### `docs/proposal/phase-1/transport.md`

Add one sentence at the end of `## HTTP is the surface, the CLI calls it`, after `:9`:

```
The version compatibility policy — what `/v1` guarantees, what a client must tolerate, and the `GET /v1/health` handshake that carries the capability list — is `../api/README.md`, section `## Versioning`.
```

## Constraints

- Edit no Routes table in `docs/proposal/api/`. `test/helpers/proposal.ts` reads every `api/*.md` except `README.md` and `new-decisions.md`, and `src/http/contract/parity.test.ts` compares the result to the registry.
- Move no `sql` fence in any proposal file.
- Add no precondition row and no idempotency row to `docs/proposal/api/README.md`. `system.health` is a `GET`.
- Add no row to `docs/proposal/api/new-decisions.md`. That file lists route decisions; this is a policy statement inside an existing section.
- Do not edit the `## system.status` section of `docs/proposal/api/system.md`.
- The commit hook runs prettier over staged markdown. Re-run the parity test after the hook.

## Verify

- `node --test test/helpers/proposal.test.ts` exits 0, which proves the route-matrix reader still parses `docs/proposal/api/system.md`.
- `node --test src/http/contract/parity.test.ts` exits 0, which proves no Routes-table row moved.
- `node --test src/http/contract/proposal-amendment.test.ts` exits 0, which proves no sentence this file already pins was disturbed.
- `npm run verify` exits 0.
- Proof: this story delivers no Proof path. It is the proposal-side statement of the policy the remaining stories implement.
