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

The dashboard's answers to this register live in `apps/AGENTS.md`, section
`## Commitments to the engine`. Seven entries are resolved there and are deleted here. Two remain,
and the dashboard has answered neither.

The dashboard's own three requests are agreed and specified. The recoverable `provider.loginComplete`
and the device-arm poll interval land in EPIC 045, together with the explicit
`provider.loginCancel` it asked for. The idempotency identity of `provider.verify` lands in EPIC 044.
Those answers are not entries here; the two epics carry them.

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

## Request 1: Confirm one daemon per home

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

## Request 2: State whether self-configured providers need more than `openai-compatible`

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
