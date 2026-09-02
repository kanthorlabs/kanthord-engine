# EPIC 023 — Version compatibility policy

Status: **draft**.

Source: `kanthord-apps/docs/api/blockers.md`, item E6. The client asks one question — may a released client
talk to a daemon of a different version, and if so, what may the client assume? Nothing in
`docs/proposal/` answers it, so the client took a tolerant position in its own `conventions.md` and
asked for it to be confirmed or replaced.

## Goal

`docs/proposal/api/README.md` states the compatibility policy, and `GET /v1/health` becomes the
handshake that carries it. The response gains `version` and `capabilities`, so a client asks what the
daemon can do instead of comparing two semver strings. A capability name is declared only when every
operation it names is `routed`, and a test enforces that.

## Non-goals

- **No `mustUpgrade` field, and no minimum client version.** See D2. The policy makes both unreachable.
- **No server-side read of `X-Kanthord-Client`.** See D3. The header stays, and no response varies by it.
- **No change to `system.status`.** It is the operator view. `capabilities` is single-homed on
  `system.health`, and a value in two places is a value that drifts.
- **No `/v2`, and no version negotiation.** The daemon serves one API version, as
  `docs/proposal/api/README.md:47` already states.
- **No deprecation mechanism.** No `Sunset` header, no per-operation `deprecatedIn`. A route this
  product removes is a `/v2` decision, and there is no `/v2`.
- **No new operation.** The epic adds no row to the registry, so `src/http/contract/parity.test.ts`
  is untouched at both its count literals, `62` at `:16` and `66` at `:24`.
- **No actor-set change.** `system.health` already admits `harness` at
  `src/http/contract/system.ts:138-147`, so the harness set of `src/http/contract/registry.test.ts:19-32`
  keeps its twelve names and its assertion at `:875` is unchanged.

## Decisions

### D1 — `/v1` is the compatibility contract, and the package version is not

**Superseded in part by EPIC 050.2.** The closed list at `:52-58`, and the sentence at `:60`, are
closed by default rather than absolutely. `docs/proposal/api/README.md` carries the exception sentence, and the capability name
covering the affected operations is retired and replaced. Nothing else in D1 changes.

`KANTHORD_VERSION` is a hardcoded literal at `src/domain/version.ts:1`, today `"27.8.1"`. One
repository ships the daemon and the CLI, so that string describes a build, and it describes the wire
contract only by accident. **The wire contract is `/v1`, and the policy binds to `/v1` alone.**

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

**The client's tolerant position is therefore confirmed, not replaced.** A client must ignore an
unknown response field and must tolerate an unknown enum member. A client that refuses either is a
client this policy cannot serve, and `docs/proposal/api/README.md` says so in one sentence.

### D2 — additive-only means one skew direction survives, so a boolean cannot express it

Under D1 an **older client against a newer daemon always works**: everything the old client knows is
still present, and everything added is invisible to it. There is no "client too old", so there is no
`mustUpgrade` and no minimum client version.

The one real skew is a **newer client against an older daemon**: the client knows a capability the
daemon has not shipped. A boolean cannot carry that, and a semver comparison answers it only if the
client hardcodes which version introduced which capability — which is the mapping the daemon already
holds and should publish instead.

So the daemon publishes **the capability list**, and the client asks for a name.

`kanthord-apps/docs/api/blockers.md` proposes `mustUpgrade` on `/v1/status`. This epic refuses that
field and answers the question behind it. The client repository records the replacement.

### D3 — the daemon never reads `X-Kanthord-Client`, and the policy says so

`src/cli/client.ts:64-67` sends the header. `src/http/server/` reads it nowhere: the only server-side
mention is the CORS allow-list at `src/http/server/preflight.ts:7`, and
`src/http/server/dispatch.ts:33-39` merely puts every header into the handler context.

**That stays true, and it becomes a decision rather than an omission.** Three consequences, and each
is a question the policy would otherwise owe an answer to:

- An absent, malformed, prerelease or future-dated header changes nothing, because nothing reads it.
- No response body varies by a request header, so no route needs a `Vary: X-Kanthord-Client`, and no
  cache can serve one client the answer computed for another. This epic adds no varying header.
  `src/http/server/origin.ts` sets `Vary: Origin`, but only on a response to a request that carries
  an `Origin` header; a request without one returns early and sets nothing. The body does vary by
  `Origin` in both cases, because a value outside the allow list is a `403`, so the early return is a
  cache defect. This epic makes `Vary: Origin` unconditional.
- The header keeps one purpose: a diagnostic in an operator's log.

### D4 — the handshake is `GET /v1/health`, not `GET /v1/status`

`system.health` admits `human` and `harness` (`src/http/contract/system.ts:138-147`).
`system.status` admits `human` only (`:162-171`), and `src/http/contract/registry.test.ts:900`
asserts that exclusion by name.

The client's connect flow already verifies a token against `GET /v1/health`, per the `daemon_connect`
step of `kanthord-apps/docs/api/blockers.md`. A harness registered by EPIC 015 needs the capability
list for the same reason a human client does. So the two fields land on the route both actors already
reach, and `system.status` is left alone rather than widened.

`systemHealthResponse` at `src/http/contract/system.ts:18-26` gains two members:

```ts
version: z.string().min(1),
capabilities: z.array(capabilityName),
```

`version` duplicates the value `system.status` reports at `:39-75`. That duplication is accepted: a
harness cannot call `system.status`, and a handshake that reports capabilities and hides the build
string is a handshake an operator cannot debug.

### D5 — a capability names a product ability, never a route, and the registry proves it

A capability list a human maintains by hand drifts from the routes it claims. The list is therefore
**derived and asserted**.

`src/http/contract/capability.ts` holds the map:

```ts
export const capabilityOperations = {
  "external-drive": [
    "node.claim",
    "node.heartbeat",
    "node.release",
    "node.report",
  ],
  "per-node-write": ["node.create", "node.update", "node.delete"],
  "project-graph": ["project.nodes", "project.graph"],
} as const satisfies Readonly<Record<string, readonly string[]>>;
```

A name is a hyphenated lower-case ability. `declaredCapabilities()` returns the names whose every
operation id is `routed` in the registry, sorted bytewise, so a capability that is declared and not
routed cannot reach the wire.

**The map lives in `http/contract/` and not in `domain/`, because it reads the registry.**
`eslint.config.js` permits `http/contract/` to import `domain/` and `http/contract/`, and it forbids
`queries/` from importing either. So `readHealth` receives the computed list as an injected value,
exactly as `readStatus` receives `version` and `bind` today
(`src/queries/system/read-status.ts:5-12`), and `src/main.ts` calls `declaredCapabilities()` once at
construction.

`project-graph` is EPIC 022's pair, and it is in the map from the start. It reports `false` until 022
routes both operations, which is the mechanism working rather than a gap.

**The list is not a route directory.** It names four abilities, not thirty-five routes. A client that
wants to know whether one route exists calls it and reads `404` or `501`; a client that wants to know
whether a _feature_ is worth rendering a screen for reads `capabilities`.

## Stories

- **The proposal states the policy** — `docs/proposal/api/README.md`, the `## Versioning` section at
  `:44-47`. The three sentences there stay and gain the two lists of D1 verbatim, the confirmation
  that a client must tolerate an unknown field and an unknown enum member, the statement that the
  daemon never reads `X-Kanthord-Client`, and the statement that `GET /v1/health` carries the
  capability list. `docs/proposal/phase-1/transport.md` mentions no version today and gains one
  sentence pointing at the `api/README.md` section, so a reader of the transport document is not left
  to infer the policy.
- **The capability map and its derivation** — `src/http/contract/capability.ts`, holding
  `capabilityName` as a zod enum over the map keys, `capabilityOperations`, and
  `declaredCapabilities()`. `src/http/contract/capability.test.ts` asserts that every operation id the
  map names exists in the registry, that `declaredCapabilities()` is bytewise sorted, that a name
  whose operations are all `routed` appears, and that a name with one `stubbed` operation does not.
- **The health response carries them** — `systemHealthResponse` at `src/http/contract/system.ts:18-26`
  gains `version` and `capabilities`, and `systemHealthExamples` gains both members so
  `src/http/contract/example.test.ts` validates them. The count literal at `example.test.ts:16` stays
  `31`, because this epic adds no operation.
- **The query and the handler** — `ReadHealthDependencies` at `src/queries/system/read-health.ts:14-16`
  gains `version: string` and `capabilities: readonly string[]`, and `readHealth` returns both, in the
  pattern of `read-status.ts:5-12,84`. **`ReadHealthResult` stops being an alias of `HealthResult`**
  (`:18`) and becomes `HealthResult` widened with the two members, because `domain/health.ts`
  describes dependency health and a build string is not health. The dependency sort at `:32-34` and
  the `degraded` rule at `:35-39` are untouched. The handler at `src/http/server/system/health.ts` is
  unchanged in shape: it parses nothing, calls one query, and formats.
- **The composition root** — `src/main.ts` calls `declaredCapabilities()` once and binds the result
  and `KANTHORD_VERSION` into the health query, beside the existing `version` binding for
  `readStatus`.
- **`Vary: Origin` becomes unconditional** — `src/http/server/origin.ts` sets it on every response,
  and not only on a response to an `Origin`-bearing request. See D3. The no-`Origin` early return
  goes, and the rest of the middleware is untouched: an absent `Origin` still sets no
  `Access-Control-Allow-Origin`, no `Access-Control-Expose-Headers` and no `context.state.allowedOrigin`.
  `src/http/server/origin.test.ts` asserts the new header on the no-`Origin` case.
- **The client repository is told** — `kanthord-apps/docs/api/blockers.md` E6 is retired, and
  `conventions.md` records that the tolerant position is confirmed and that `mustUpgrade` is refused
  with its replacement named. That is a commit in the client repository, and it is an Open item here
  rather than a story of this epic.

## Verification Gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/contract/capability.test.ts \
  src/http/contract/system.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/parity.test.ts \
  src/queries/system/read-health.test.ts \
  src/http/server/system/health.test.ts \
  src/main.capability.test.ts \
  && echo "PASS EPIC-023"
```

Hermetic coverage required beyond the Proof:

- **The route-level acceptance test.** `src/main.capability.test.ts` launches the real daemon through
  `launchDaemon` and asserts that `GET /v1/health` answers `200` with `version` equal to
  `KANTHORD_VERSION` and `capabilities` equal to `declaredCapabilities()`, member for member and in
  order. It uses no injected handler map, so the assertion covers the production composition root.
- **A harness reads the handshake.** The same test drives `GET /v1/health` with a harness token and
  asserts `200` with the identical body, and drives `GET /v1/status` with the same token and asserts
  `403 actor-forbidden`. That proves D4 rather than restating it.
- **The response does not vary by the client header.** Two `GET /v1/health` calls, one with
  `X-Kanthord-Client: 0.0.1`, one with `X-Kanthord-Client: 999.0.0`, and one with the header absent,
  return byte-identical bodies, compared through `Buffer.compare` on the raw response text. A
  malformed value — `X-Kanthord-Client: not a version` — returns the same bytes and `200`, never a
  `400`. This is D3 asserted.
- **No response carries `Vary: X-Kanthord-Client`.** Asserted over the response headers of
  `GET /v1/health`, `GET /v1/status` and one POST route. `Vary: Origin` is asserted still present, so
  the assertion cannot pass by the header machinery being broken.
- **A capability is declared only when it is routed.** `capability.test.ts` builds the derivation
  against a fixture registry in which one named operation is `stubbed`, and asserts the name is
  absent. Against the real registry it asserts the exact expected list at this point in the block.
- **Every capability name resolves.** Every operation id in `capabilityOperations` is found by
  `findOperation`, asserted by name. A typo therefore fails `npm run verify` rather than silently
  suppressing a capability.
- **The map keys and the zod enum agree.** `capabilityName.options` equals `Object.keys(capabilityOperations)`,
  bytewise sorted, so a name added to one and not the other fails.
- **The additive rule is asserted where it is checkable.** `systemHealthResponse` is a
  `z.strictObject`, so a test asserts that a body carrying an unknown key fails `parse`, and that a
  body missing `capabilities` fails `parse`. The policy's client half — tolerate an unknown field —
  is a client obligation and is not asserted here.
- **`GET /v1/health` writes nothing.** The full contents of `event` plus `PRAGMA data_version` are
  compared before and after the call.
- `src/http/contract/parity.test.ts` still asserts `62` and `66`, unchanged, proving the epic added
  no operation.
- `npm run lint` passes with `queries/` importing no file from `http/contract/`, which is the
  boundary that forced the injection of D5.

## Open items

- **A capability the daemon has and the client cannot name.** The list is additive, so a client
  written against an older list ignores a newer name. That is the intended behaviour and it is
  recorded here because it is the one case the policy leaves silent.
- **The client repository commit.** Done in the working tree, and it is not committed yet.
  `kanthord-apps/docs/api/blockers.md` retires E6 into the ledger row that points at
  `conventions.md`. `conventions.md` replaces `## Version compatibility is undefined` with
  `## Version compatibility is stated`, which records the two lists of D1, the confirmation of the
  tolerant position, the `mustUpgrade` refusal with `capabilities` named as the replacement, and D3.
  `parallel-development.md` and the two client epics that cited `blockers.md` E6 point at
  `conventions.md` instead. This epic does not close before that commit lands.
- **A per-operation capability for phase 2.** Phase 2 adds runs, attempts and workers, and each
  becomes a capability name under the same rule. EPIC 115 owns the list at that point; this epic
  fixes the mechanism and not the membership.
