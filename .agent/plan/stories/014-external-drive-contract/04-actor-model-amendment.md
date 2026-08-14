# Story 4 — The actor-model amendment

Epic: `.agent/plan/epics/014-external-drive-contract.md`
Depends on: EPIC 013 (sequence order). Independent of Stories 1 to 3.

Document-only story. It writes no TypeScript.

## Change

### `docs/proposal/phase-1/transport.md:19`

The line reads today: `There is no user model. One token serves one human.`

Replace it with exactly:

```
A user model exists. The configured bearer token resolves to a bootstrap `human` actor, and a registered actor holds its own token. A registered actor is a `human` or a `harness`, and `harness` is the second registered actor kind. `daemon` stays the third actor kind of the event log, and it registers nothing. EPIC 015 lands the enum, the service-interface type and the `CHECK`.
```

Line 17 and line 21 stay word for word. Line 21 keeps the no-anonymous-surface rule unchanged.

### `docs/proposal/api/README.md:144-148`

The section reads today:

```
## The actor

`event.actor_id` and `candidate.approved_actor` record who decided. The daemon reads that name from configuration, and no request carries it.

There is no user model, and one token serves one human, so an actor field on a request would be a claim rather than a fact. Every human decision — approve, discard, waive, abandon, unblock — stamps the configured name.
```

Replace lines 146 and 148 with exactly these two paragraphs, keeping the `## The actor` heading at line 144 and the blank lines:

```
`event.actor_id` and `candidate.approved_actor` record who decided. The token identifies the actor, and `event.actor_id` records the resolved actor rather than a configured name.

A user model exists. A registered actor is a `human` or a `harness`, and `harness` is the second registered actor kind. `daemon` stays the third actor kind of the event log, and it registers nothing. No request carries an actor field, because a request that names its own actor states a claim rather than a fact: the daemon resolves the actor from the bearer token it authenticated. Every human decision — approve, discard, waive, abandon, unblock — stamps the resolved actor. EPIC 015 lands the enum, the service-interface type and the `CHECK`.
```

### `docs/proposal/api/graph.md:7`

The heading reads today: `## Only a human mutates the graph`

It becomes: `## Only an actor mutates the graph`

### `docs/proposal/api/graph.md:9`

Unchanged, word for word. It stays true: `Through this API, or through export, edit and re-import. No agent route exists here, and no route accepts a state field. The daemon owns state, so a client never writes one.`

## Constraints

- Change no route table row of `docs/proposal/api/graph.md`. `test/helpers/proposal.ts:54` `readRouteMatrix` parses every five-column route table under `docs/proposal/api/`, and `src/http/contract/parity.test.ts` compares it against the registry. A heading edit and a prose edit are outside that parse; a table edit is not.
- Change no file under `src/`. `src/domain/event.ts:6` keeps `["human", "daemon"]`, and `src/services/event/index.ts:3` keeps its second `ActorKind` union. EPIC 015 widens both in one change with the migration.
- Change no `docs/proposal/database/` file.
- Name `harness` as the second actor kind in both `transport.md` and `README.md`, and name EPIC 015 in both.

## Verify

- `npm run verify` exits 0. `src/http/contract/parity.test.ts` proves the `graph.md` route table survived the edit.
- `node --test src/domain/event.test.ts` exits 0 with no edit, and `src/domain/event.ts` still exports exactly two actor kinds.
- `grep -c "no user model" docs/proposal/phase-1/transport.md docs/proposal/api/README.md` returns `0` for both files.
- `grep -n "harness" docs/proposal/phase-1/transport.md docs/proposal/api/README.md` returns at least one line in each file.
- `grep -n "Only an actor mutates the graph" docs/proposal/api/graph.md` returns line 7.
- Proof: `PASS EPIC-014` through the unchanged `src/domain/*.test.ts` glob. Hermetic coverage: the two-actor-kind bullet at `.agent/plan/epics/014-external-drive-contract.md:100`.
