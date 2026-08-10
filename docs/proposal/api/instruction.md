# Agent, template, profile

Reviewer: AI engineer. Conventions are [README.md](README.md). The decisions are `../phase-2/instructions-and-profiles.md` and `../phase-2/agents-and-workers.md`.

What an agent is told, and where that text is stored.

## Routes

| operationId              | Method and path                          | introducedIn | status   | Source                                               |
| ------------------------ | ---------------------------------------- | ------------ | -------- | ---------------------------------------------------- |
| `agent.list`             | `GET /v1/agent`                          | phase-2      | stubbed  | domain.md, agent roles                               |
| `template.list`          | `GET /v1/template`                       | phase-2      | stubbed  | instructions-and-profiles.md, templates              |
| `template.show`          | `GET /v1/template/:id`                   | phase-2      | stubbed  | instructions-and-profiles.md                         |
| `profile.instantiate`    | `POST /v1/repository/:id/profile`        | phase-2      | stubbed  | phase-2 onboarding, "instantiate a profile"          |
| `profile.export`         | `GET /v1/repository/:id/profile`         | phase-2      | stubbed  | instructions-and-profiles.md, export                 |
| `profile.import`         | `PUT /v1/repository/:id/profile`         | phase-2      | stubbed  | instructions-and-profiles.md, import                 |
| `profile.verify`         | `POST /v1/repository/:id/profile/verify` | phase-2      | stubbed  | instructions-and-profiles.md, gates A and B          |
| `instructions.resolve`   | `GET /v1/instruction/resolve`            | phase-2      | stubbed  | instructions-and-profiles.md, `instructions resolve` |
| `binding.provider.agent` | `PUT /v1/agent/:role/binding/provider`   | post-mvp     | deferred | providers-and-credentials.md, deferred               |

## `agent.list`

Returns every agent role, its role contract identity and its tool set. It is read-only in every phase. Capability is enforced in the agent implementation, so no route widens a tool set and no body field names one. The MVP implements `general@1` and `re@1`; `swe@1`, `te@1` and `git@1` appear with a deferred marker.

## The profile lives in the database

The profile is a markdown document with the frontmatter contract of `../phase-2/instructions-and-profiles.md`. `profile.export` returns the document, and `profile.import` replaces it. The database is canonical, so a working tree never feeds the resolver, and an agent cannot rewrite the instruction that governs its own run.

`profile.import` rejects a `checks` command that cannot fail. It returns `422` with the offending check name.

The response of both routes carries the profile content hash. An objective pins that hash on its workspace when the clone is created, so an edit during a run cannot change instruction mid-objective, and a result recorded last month still resolves to the exact command that ran then.

A repository has exactly one profile, and an edit writes a new blob and moves the pointer. The old document stays under its own hash, so nothing that cited it changes meaning.

## `profile.instantiate`

The body names the template id and the fields the human confirmed. Template detection is deferred, so the client supplies the template id in the MVP. The stored profile records the template id, version and digest, so a later template change is a diff a human reads.

## `profile.verify`

The body names the gate: `A` or `B`. Gate C is deferred and returns `400` with the reason.

Verification is manual and it never blocks. The response reports each gate result. Gate B records a `check_result` of subject kind `profile-gate`. Gate A returns its report and records no row, because it runs no command and a row needs a commit. Those results belong to no node, so `node.checks` never returns them and this route is the only way to read them.

A wrong profile still surfaces later as tasks that park in `blocked`, and the daemon never claims otherwise.

## `instructions.resolve`

Query parameters are `agent` and `node`. The response is the composed prompt with per-block provenance, one entry per channel: the channel name, the source blob hash, its byte count, and a `from` label naming the row, the pin or the code version that produced it. It also carries the budget accounting and the dropped channels.

That is the same shape `agent_invocation.sources_json` records, and it is deliberately the same, so a human compares a prospective render against a recorded attempt field by field. **It is not read from `sources_json`.** This route is prospective: it runs no model, calls no provider, and inserts no invocation row, so there is no stored document to render from. The resolver composes it live.

### Budget and the ambient channel

Budget is enforced per channel, and the failure is a refusal. A non-ambient channel over its cap returns `409` and names the channel. The resolver never truncates, because truncated instruction produces work that looks valid and is not.

**Ambient is the one channel the resolver may drop**, and a drop is not a refusal. `../phase-2/instructions-and-profiles.md` allows it, and a drop writes an event. So a resolve whose ambient channel exceeded the cap returns `200` with that channel listed under `dropped`, and a resolve whose role contract or repository profile exceeded it returns `409`. The two look identical to a reader who only counts bytes, and the response has to distinguish them.

The refusal body carries the same provenance and budget document, so a human sees which channel overran and by how much, before a run pays for it.
