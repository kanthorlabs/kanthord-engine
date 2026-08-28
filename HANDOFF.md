# Dashboard Handoff

Document version: 2026-08-28
Authors: kanthord engine agents (engine repository)
Addressed to: dashboard team (apps repository)
Reads: `apps/HANDOFF.md`

This document lists every decision, obligation and confirmation the engine needs from the dashboard
team and cannot supply itself. A different team maintains the engine; the dashboard team does not
have the engine's context. This document is the authoritative source for what the engine is waiting
on.

**It is a register of open requests, not a record of answers.** An entry that the dashboard resolves
is deleted from the next version, completely. Nothing here restates a settled question, and nothing
here reports work the engine has already specified. The answers to `apps/HANDOFF.md` live in the epic
files under `.agents/plan/epics/`, in `docs/proposal/`, and in the published OpenAPI document. Read
them there.

## Document Schema

Each entry carries:

- **Priority** — `BLOCKING` (engine work is stopped, or will ship wrong without an answer) or
  `NICE-TO-HAVE` (the engine has a default and will proceed on it)
- **Status** — `NEEDS-DECISION` (the choice is the dashboard team's) or `NEEDS-COMMITMENT` (the
  engine's design depends on the dashboard doing something)
- **What the engine needs** — the answer or the action, stated as one thing
- **Why the engine cannot settle it** — the constraint, with a file and a line
- **What the engine does in the meantime** — the default it proceeds on if no answer arrives
- **Cost of a late answer** — what has to change if the answer arrives after the epic merges

Schema justification: this mirrors the schema of `apps/HANDOFF.md` so one reader parses both. Two
fields differ, because the direction differs. `apps/HANDOFF.md` asks for capability and therefore
carries request and response schemas. This document asks for decisions, so it carries the default the
engine proceeds on and the cost of changing it later — the two facts a decision-maker needs.

---

## Request 1: Approve the `force` parameter on `provider.remove`

**Priority**: BLOCKING
**Status**: NEEDS-DECISION

**What the engine needs**: approval to add `force` as a query parameter on
`DELETE /v1/provider/:id`, overriding the `default-chain` blocker and only that blocker.

**Why the engine cannot settle it**: your Gap 1 says "No `force` parameter. If the refusal turns out
to be a deliberate safety interlock rather than an oversight, do not build a blanket force — come
back to us first." This is that. The engine did not delete lines 68-70 of
`src/commands/provider/remove-provider.ts` as you asked, because
`.agents/plan/epics/101-credential-registry-completion.md:61` holds a merged Proof asserting that an
unforced removal of a stamped provider refuses with `default-chain`. Deleting the blocker breaks that
Proof, and a merged Proof is a regression gate here. So the blocker stays and an explicit override
sits beside it.

**The force is not blanket.** A `project-binding`, `repository` or `attempt` blocker refuses a forced
removal exactly as it refuses an unforced one, for the reasons you gave.

**Two consequences you should weigh before answering.**

- A forced removal leaves the `llm` default chain with no head, and the engine appoints no successor.
  Your screen must prompt the human to call `provider.setDefault`. No event and no warning marks the
  headless state.
- `?force=` with an empty value is `400 invalid-request`. A destructive override is stated, never
  inferred from a client that built the query by concatenation.

**What the engine does in the meantime**: proceeds with the parameter. EPIC 042 is specified on it.

**Cost of a late answer**: low before the epic merges, high after. Removing the parameter later is a
contract narrowing that breaks any dashboard call site already sending it.

---

## Request 2: Accept that credential verification spends a few tokens

**Priority**: BLOCKING
**Status**: NEEDS-DECISION

**What the engine needs**: acceptance that `provider.verify` sends one 16-token completion to the
registered default model, or an instruction to drop OAuth and multi-vendor coverage in exchange for a
free probe.

**Why the engine cannot settle it**: your Gap 3 says "Do not bill the user to verify a key" and asks
for a models list or an equivalent metadata endpoint. The engine cannot meet that and still be
correct:

- `GET <baseUrl>/models` with a bearer header is OpenAI-shaped. `anthropic` and `google` use a
  different header and path, so that probe reports a good key as rejected for both.
- A models list proves nothing about an OAuth credential, which the subscription work makes a
  first-class credential type.

The prompt is the fixed string `What time is it?`, output is capped at 16 tokens, the reply text is
never parsed or returned, and the operation is `memory`-idempotent so a retry makes no second call.
There is no background sweep; every verification is initiated by a human, as you asked.

**What the engine does in the meantime**: proceeds with the completion probe. EPIC 044 is specified
on it.

**Cost of a late answer**: moderate. The verdict shape survives either probe, so a later switch to a
models list changes the probe and the refusal set, not the response contract. It would also silently
stop covering OAuth credentials, which is the part worth deciding now.

---

## Request 3: Ship a no-code submit on the manual-code login arm

**Priority**: BLOCKING
**Status**: NEEDS-COMMITMENT

**What the engine needs**: a commitment that the subscription-login screen can call
`provider.loginComplete` with **no** `code` field on the manual-code arm.

**Why the engine cannot settle it**: `pi-ai` races its own local callback server against the
pasted-code prompt, and the engine cannot stop it. `anthropic` binds a fixed port and `openrouter` an
ephemeral one. When the human's browser reaches that port — the single-machine case, which is the
common one — the callback wins and the login resolves with no code in existence. A form that blocks
submission on an empty field then strands the human on a login that already succeeded.

The engine's side is handled: an absent `code` succeeds when the flow already resolved, and refuses
`code-required` only while it is still waiting. The engine cannot make the browser miss the callback,
so the recovery has to be in the UI.

**What the engine does in the meantime**: ships the operation accepting an absent `code`. Nothing on
the engine side blocks.

**Cost of a late answer**: none to the engine, and a broken login for every same-machine human until
the dashboard ships the submit.

---

## Request 4: Poll `provider.loginComplete` on the device-code arm

**Priority**: BLOCKING
**Status**: NEEDS-COMMITMENT

**What the engine needs**: a commitment to treat `409 illegal-transition` with refusal
`login-pending` as the normal answer and retry, not as an error to surface.

**Why the engine cannot settle it**: five of the seven subscription vendors return a device-code
challenge. `pi-ai` polls the vendor inside the daemon, and the engine will not block an HTTP request
for up to fifteen minutes waiting for a human to approve on another device. So the pending state has
to reach the client, and only the client can loop.

Two related obligations in the same screen: drive every countdown from the `expiresAt` the engine
returns and never from a constant, because the manual arm and the device arm expire on different
clocks; and render `login-expired` differently from `404 not-found`, because the first expired call
answers `login-expired` and deletes the login, and every later call answers `404`.

**What the engine does in the meantime**: ships the refusal. Nothing on the engine side blocks.

**Cost of a late answer**: none to the engine. Without the loop, no device-code vendor can be
registered at all.

---

## Request 5: Map the new refusal strings

**Priority**: BLOCKING
**Status**: NEEDS-COMMITMENT

**What the engine needs**: a commitment that `src/api/errors.ts` reads `error.details.refusal` and
falls back on an unknown value.

**Why the engine cannot settle it**: `error.code` is a closed set of 23 members
(`src/http/contract/errors.ts:7-30`) and the engine is adding **no** member to it. Every new cause
therefore arrives as an open string inside `error.details.refusal`. Your own entry says the dashboard
declares 12 of the 23 codes and may fall through on the rest; the refusal strings widen that surface,
because several distinct causes now share one code.

The strings the engine adds:

```
provider-not-oauth-capable   login-input-required      login-method-unavailable
login-in-progress            login-pending             login-expired
login-already-complete       login-lost                code-required
code-not-accepted            provider-not-verifiable   endpoint-unreachable
credential-rejected          model-unavailable         quota-exceeded
endpoint-rejected            empty-remote
```

Two of them need distinct messages rather than a generic failure. `quota-exceeded` and
`model-unavailable` both arrive with `authentication: "accepted"`, so a human must be told the key is
fine and something else is wrong. `empty-remote` means push a first commit, not fix the credential.

**What the engine does in the meantime**: keeps `details.refusal` an open string, as you asked, so a
new cause is never a breaking change.

**Cost of a late answer**: none to the engine. Unmapped refusals render as an unhandled-error
fallthrough.

---

## Request 6: Confirm one daemon per home

**Priority**: NICE-TO-HAVE
**Status**: NEEDS-DECISION

**What the engine needs**: confirmation that the dashboard never talks to a load-balanced pool of
kanthord daemons sharing one database.

**Why the engine cannot settle it**: the engine assumes it, and the assumption is load-bearing for
the subscription login. `src/services/home-lock/sqlite.ts` takes an exclusive home lock and refuses a
home on a network filesystem, so two instances cannot share one home today. The login design relies
on that: a suspended OAuth flow lives in the process that started it, because `pi-ai` holds its PKCE
verifier in a closure and exposes no resumable state. If a pool is ever a deployment target, the
window between `provider.loginStart` and `provider.loginComplete` needs sticky routing, and the
engine would rather learn that now than design the affinity twice.

**What the engine does in the meantime**: proceeds on one daemon per home. A restart in that window
refuses `login-lost`, and the human starts again. A completed login is instance-independent, so
registration always survives a restart.

**Cost of a late answer**: high. Supporting a pool means either sticky routing in your infrastructure
or a resumable OAuth flow in the engine, and the second means re-implementing PKCE, which EPIC 045
refuses.

---

## Request 7: Decide whether a pending login needs a cancel operation

**Priority**: NICE-TO-HAVE
**Status**: NEEDS-DECISION

**What the engine needs**: a decision on whether the human may abandon a subscription login and
immediately start another for the same vendor.

**Why the engine cannot settle it**: the engine ships no cancel, and a second
`provider.loginStart` for a vendor with a pending login refuses `login-in-progress`. So an abandoned
login locks that vendor until it expires — ten minutes on the manual arm, and the vendor's own
lifetime on the device arm. The engine chose the refusal over a supersede because `anthropic` binds a
fixed port for the life of its flow, and cancelling a live flow races the abort against the callback.
Whether that wait is acceptable is a product judgement about your screen, not an engine judgement.

**What the engine does in the meantime**: refuses the second start, and expects the dashboard to show
the countdown from `expiresAt`.

**Cost of a late answer**: low. A cancel is an additive operation over the same login row, so it can
land in a later epic without changing anything already shipped.

---

## Request 8: State whether self-configured providers need more than `openai-compatible`

**Priority**: NICE-TO-HAVE
**Status**: NEEDS-DECISION

**What the engine needs**: whether a human must be able to register a provider under an id the
`pi-ai` catalogue does not carry.

**Why the engine cannot settle it**: registration is gated on `catalog.has(payload.provider)`
(`src/commands/provider/register-provider.ts:53`), and `openai-compatible` is the single escape
hatch — the only catalogue entry with `requiresBaseUrl: true`
(`src/domain/provider-payload.ts:9` and `:66`). That already covers any OpenAI-compatible endpoint
with a `baseUrl` and a key, and `ModelCatalog.inspect` discovers its models. It does **not** cover a
human who wants two distinct self-hosted endpoints under their own names, or a non-OpenAI-shaped
endpoint. Whether either is a product requirement is yours.

Note that subscription OAuth cannot extend to a self-configured endpoint at all: there is no `pi-ai`
`oauth` member to drive, so no flow exists.

**What the engine does in the meantime**: keeps `openai-compatible` as the one escape hatch and adds
nothing.

**Cost of a late answer**: low. It is a separate epic against one gate, and it changes nothing already
shipped.

---

## Request 9: Take contract types from a published document

**Priority**: BLOCKING
**Status**: NEEDS-COMMITMENT

**What the engine needs**: a commitment to generate the dashboard's types from a published OpenAPI
document at a commit where the answering epic has merged.

**Why the engine cannot settle it**: your entry mirrors `src/api/types.ts` from
`docs/api/contract/openapi.yaml` and asks that engine type changes land in the spec before a handler
routes. The engine agrees on the process and cannot supply that path: **it commits no OpenAPI
document.** A generated document is never committed and never hand-edited here. Run
`npm run contract:publish -- <output-directory>` in the engine repository to emit the master
document, the `features/*.yaml` slices and the examples. `npm run verify` emits and validates all of
them in a temporary directory, so a merged epic always has a valid spec behind it.

**One thing to hold.** Every epic answering `apps/HANDOFF.md` is `draft` and unmerged. Do not build a
call site against an operation until its epic merges and a published document carries it.

**What the engine does in the meantime**: keeps the publish command working and keeps the emitted
documents self-contained.

**Cost of a late answer**: high if the dashboard hand-writes types from this document instead of
generating them. The engine will not treat a hand-written mirror as a contract.
