# Story 12 — The proposal records the flow

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`
Depends on: Story 10 (the route matrix must match the registry).

`docs/proposal/` is the source of truth for behaviour, and two tests read it as data:
`parity.test.ts` compares the route matrix to the registry, and the migration test compares
the sql fence to the DDL. Write the decision, not the search for it — no alternatives, no
comparisons, no rejected options.

## Change

### `docs/proposal/api/credential.md`

1. **The route matrix** (`docs/proposal/api/credential.md:15-25`). Add three rows. Column
   format and cell spelling must match `readRouteMatrix` exactly
   (`test/helpers/proposal.ts:53-84`): five cells, the method and path in one backticked
   cell, `introducedIn` from the closed set, and the status word.

   ```
   | `provider.loginStart`    | `POST /v1/provider/login`          | phase-2      | routed | providers-and-credentials.md, subscription sign-in |
   | `provider.loginComplete` | `POST /v1/provider/login/complete` | phase-2      | routed | providers-and-credentials.md, subscription sign-in |
   | `provider.loginCancel`   | `POST /v1/provider/login/cancel`   | phase-2      | routed | providers-and-credentials.md, subscription sign-in |
   ```

   Place them in the table's existing order convention. `parity.test.ts:25` expects
   **77** proposal rows after this edit.

2. **A new section, `## Subscription sign-in`**, after `## \`provider.verify\``(which ends
at`:105`). Follow that section's style: prose, one fenced `ts` block for each response
   shape, and one-paragraph rules. It states, in this order:

   - Registration is three steps, in the order a human works in: authenticate, list the
     models the account can use, then register.
   - `pi-ai` owns the OAuth protocol and the refresh. The engine writes no PKCE code, no
     state, no token exchange, no refresh logic and no redirect handler. The engine supplies
     storage and transport.
   - The admitted vendor set is derived from the library at startup: every builtin provider
     whose `auth.oauth` is present. The engine holds no vendor list, and a new vendor in
     `pi-ai` costs no engine edit.
   - The method preference rule: where a flow offers a choice, the engine takes the
     device-code branch and falls back to the browser branch. The recognized option
     spellings are `device-code` and `device_code`; a flow offering neither refuses
     `login-method-unavailable` and names the ids it saw. A third spelling is a named engine
     edit, deliberately, rather than a silent fall-through to a branch that binds a local
     port.
   - The two challenge arms, as a fenced `ts` block giving both shapes exactly as
     `providerLoginStartResponse` declares them.
   - `pollIntervalMs` is the vendor's own interval in milliseconds, five seconds when the
     vendor omits it. It is guidance, not a gate: `pi-ai` polls the vendor inside the daemon
     on the vendor's schedule, and `provider.loginComplete` only reads the state of that
     in-process flow. A dashboard that polls faster costs one local request and no outbound
     call, and the engine applies no rate limit of its own.
   - The three login states: `pending`, `completed`, and consumed — `provider.register`
     deletes the row in the transaction that creates the provider.
   - The completed replay: a second `complete` for the same `loginId` answers the same
     `{ loginId, models }`, makes no vendor call and changes no row. The row is the
     idempotency record, so the replay needs no `Idempotency-Key`. Without it a dropped
     `200` strands the human, who holds no model list while the engine holds a credential.
   - The two expiry rules: the manual arm is `created_at` plus ten minutes; the device arm
     is the clock at the `device_code` event plus the lifetime that event reports, ten
     minutes when it reports none. The device code starts its own lifetime when the vendor
     issues it, which is after every preceding prompt.
   - Expiry is a transition that happens once: the first request to observe an expired row
     refuses `login-expired`, aborts the live flow, closes whatever the library opened, and
     deletes the row. A replay then answers `not-found`, so a client tells an expiry from a
     replay by the first answer it receives.
   - `provider.loginCancel` takes a `loginId`, aborts the live flow through its
     `AbortSignal`, lets `pi-ai` close its callback server or stop its poll, and deletes the
     row in the same transaction. It is the only way to release a vendor before `expiresAt`.
     A cancel of a `completed` row deletes it and discards the credential. It is explicit
     rather than a `start` that supersedes, because an abandoned flow may still hold a live
     callback that resolves later, and a silent supersede would race two flows for one
     vendor.
   - One pending login per vendor; a second `start` refuses `login-in-progress`.
   - A restart loses the live flow. The row records the daemon instance that holds it, and a
     `complete` on a `pending` row from another instance refuses `login-lost` and deletes
     the row. A `completed` row holds no live flow and is instance-independent.
   - The transport discriminator: the `llm` arm carries `transport`, absent means
     `api-key`, and the oauth arm requires `transport: "oauth"`.
   - The projection: `{ transport, provider, defaultModel, baseUrl }` for api-key and
     `{ transport: "oauth", provider, defaultModel }` for oauth. No token field exists on
     either, and no operation returns `access`, `refresh` or `expires`.
   - The catalogue reports only what is static: each provider carries `oauth`, `null` for a
     vendor with no flow and `{ label }` otherwise, where `label` is `loginLabel ?? name`.
     The method and any needed prompt answer are not reported, because both are discovered
     only while `login()` runs.
   - A closing invariant line in the style of `:105`: the token, the code, the callback
     state and every response body of the three operations stay out of every log.

3. **The 204 exception.** `provider.loginCancel` answers `204`, and
   `docs/proposal/api/README.md:159` currently states that every route answers `200` on
   success. Amend that line to carry the exception: a command whose whole result is "the
   thing is gone" answers `204` with no body, and `provider.loginCancel` is the only such
   route. State it in one sentence in the existing paragraph; do not add a section. See
   blocker **B4** in the index — if the human prefers to keep the invariant, Story 10
   changes to `200` instead and this edit is dropped.

4. **The segment additions.** Story 1 already amends the kind table at
   `docs/proposal/api/README.md:137-143`. Do not repeat that edit here; confirm it landed.

### `docs/proposal/phase-2/providers-and-credentials.md`

1. Extend `## Pi-ai owns credential resolution` (`:17-27`). Replace the two forward
   references with the delivered behaviour:

   - `:23` — the `resolveProviderAuth` note. It is still not a public export; the sentence
     stays, and the "EPIC 045 may revisit this" clause is deleted, because this epic did not
     revisit it.
   - `:25` — "Verification covers all credential types by construction. EPIC 045 adds OAuth,
     with no change to the probe or the outcome table." Replace it. The probe and the
     outcome table are unchanged, but the credential store and the row it reads are not: the
     store now serves an api-key or an oauth credential, and the probe admits a vendor that
     carries only an oauth flow. State that, and state that a credential the library
     refreshes is written back through `CredentialStore.modify`, which re-encrypts the one
     provider row inside one storage transaction and appends
     `provider.credentialRefreshed`. A refresh that fails leaves the stored credential
     unchanged.
   - **Add a paragraph stating the two departures from the library's `modify` contract.**
     `pi-ai` asks for mutual exclusion per provider id and for the callback to see the
     current credential; the engine's adapter is built per probe over an already-decrypted
     row, so it holds no lock and the callback sees a snapshot. Two concurrent verifies of
     one oauth registration can therefore both refresh: under refresh-token rotation the
     second usually fails and reports a spurious `rejected`, and where both succeed the later
     write wins. No row is corrupted, because the write is a whole-payload replace inside one
     transaction. Say plainly that this is a known limitation of the adapter's lifetime and
     not a consequence of the snapshot rule below it — the snapshot rule governs the probe's
     read, and its reason is lock duration across a vendor round-trip.
   - `:27` — the credential-snapshot-at-request-start paragraph **stays as written**. Do not
     widen it to cover the write path, and do not cite it as sanctioning the stale-read
     `modify`. Its scope is the probe and the meaning of a verdict.

2. Extend `## Credentials are encrypted at rest` (`:5-15`) with one paragraph: a pending
   login is a second encrypted record, in `provider_login`, holding the credential and the
   model ids the vendor issued, sealed with the same master key. It lives from the moment
   the vendor issues the credential to the moment `provider.register` consumes it, and it is
   deleted by registration, by cancel, or by expiry.

3. Add `## How the dashboard learns a credential is irrecoverable` — one short paragraph:
   the dashboard calls `provider.verify`, which answers `authentication: "rejected"` when
   the refresh fails. No new field and no new operation.

4. Add `## Two deployment decisions this design rests on`:

   - The daemon runs on a single host with no load-balanced pool. The dashboard team
     confirmed it, and the home lock enforces it: the daemon holds an exclusive lock
     (`src/services/home-lock/sqlite.ts`) and refuses a home on a network filesystem, so two
     instances cannot share one database. That is why a pending login may be process-local
     and needs no sticky routing and no resumable flow.
   - `openai-compatible` is the only self-configuration escape hatch. The dashboard team
     confirmed it needs nothing more, so registration keeps its catalogue gate
     (`src/commands/provider/register-provider.ts:53`). Subscription OAuth cannot reach a
     self-configured endpoint in any case: `openai-compatible` carries no `pi-ai` `oauth`
     member, so there is no flow to drive.

### `docs/proposal/database/provider_login.md`

Story 3 creates this file. Confirm it exists and that its first sql fence still matches the
migration; do not write it twice.

### `HANDOFF.md`

`HANDOFF.md:21` reads "**None. The engine is waiting on nothing.**" This epic asks the
dashboard for nothing new, so the file is unchanged. Do not add a register of answers —
`HANDOFF.md:13-17` forbids it, and the epic plus this proposal edit are the record.

## Constraints

- No alternatives, no rejected options, no measurements, no debate. Record the decision and
  the constraints it imposes.
- Every claim about the engine cites a file and a line. Every claim about the library cites
  the package path.
- The route matrix cells match `readRouteMatrix` exactly, or `parity.test.ts` fails.
- Do not hand-edit any generated OpenAPI document, and do not commit one.
- Do not restate a delivered contract in `HANDOFF.md`.

## Verify

```
node --test src/http/contract/parity.test.ts
npm run verify
```

`parity.test.ts` asserts the registry and the proposal matrix agree with no missing,
extra or mismatched row, at 73 comparable registry rows and 77 proposal rows.
`npm run verify` runs `prettier --write docs`, so the tables reflow; commit the reflowed
form.

Proof: no `node --test` line of the EPIC Proof block is delivered by this story. It is
required for `npm run verify` to exit 0, which the Gates line demands.
