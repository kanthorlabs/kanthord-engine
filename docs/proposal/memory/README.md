# Memory

Reviewer: architect and AI engineer. This directory defines what KanthorD remembers, where a memory is filed, and how an agent gets it back. It names no phase. A phase README adopts it when the work is scheduled, and `after-the-mvp.md` records the schedule.

Every statement here is a decision, on the rule of [../README.md](../README.md).

## The problem this solves

An agent starts every attempt with no experience. The attempt record of `../phase-2/agents-and-workers.md` already holds what happened — the rendered prompt, the tool trace, the diff, the verification output, the reviewer reason. That record is evidence, and evidence is not memory. Nothing reads it back into the next attempt, and nothing carries a lesson from one repository to another.

Memory is the curated layer above that evidence. It is small, it is addressed, and a human can read all of it.

## Two layers, not one

Memory is a **decision log** and a **taxonomy projection**, and they are different things.

| Layer              | Holds                                                                                                                                               | Mutable |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| The memory journal | every candidate, its relevances, the admission outcome, and every act that changes the taxonomy — vocabulary, proposal, relation, lifecycle, import | no      |
| The taxonomy       | the active facts, filed at paths, and the catalog that indexes them                                                                                 | yes     |

Every provider call is recorded beside the journal, one row per call, in `memory_inference`.

The journal is append-only and it is the audit trail. The taxonomy is the working set an agent reads. Replaying the journal rebuilds the whole taxonomy — vocabulary included — and that is what makes a policy change safe: the rule changed, the history did not. [architecture.md](architecture.md) enumerates the acts.

This is not a second copy of the attempt record. The journal holds decisions about memory, and it cites the attempt blobs rather than copying them. That distinction was the reason for rejecting a raw-event design, and it was too broad: the objection is to duplicating traces, not to recording decisions.

## Memory is a taxonomy, not a log of traces

A memory is filed at a path.

```
domain / topic          a topic path, the address facts are filed at
domain / topic / fact   a fact path, one fact at that address
```

`backend-developer / messaging` and `backend-developer / messaging / outbox-pattern`

One address with an optional leaf, and one renderer. The router, the classifier and a filing all work in topic paths; the fact segment appears only where a single fact is identified, which is the export of [portability.md](portability.md). The two are named apart because calling a two-segment result a "complete path" is how a reader starts inventing a third form.

The path is a typed segment tuple. This is the rule `AGENTS.md` already applies to an HTTP route, and it applies here for the same reason: a free-form string address drifts into a second vocabulary that nothing validates.

- **Domain** is a field of work. A curated registry, capped.
- **Topic** is a subject inside a domain. A curated registry, capped.
- **Fact** is the memory itself.

Two of those sets are closed in code and two are validated against a registry, and the difference is stated rather than blurred.

| Set       | Kind                     | Changed by                            |
| --------- | ------------------------ | ------------------------------------- |
| scope     | closed set in code       | a code change                         |
| fact kind | closed set in code       | a code change                         |
| domain    | curated registry, capped | a human, through the vocabulary route |
| topic     | curated registry, capped | a human, through the vocabulary route |

### The vocabulary is global, and the scope belongs to the fact

There is one domain and topic registry for the daemon. `messaging` means the same subject whoever owns the memory filed under it. Scope is a property of the fact, not of the vocabulary.

A per-scope vocabulary was the first design and it was wrong. It let `project/database` and `personal/database` drift into two unrelated subjects while a recall ranked their labels as comparable, and it multiplied the cap by the number of scopes so the catalog was never actually bounded.

### A fact is filed at more than one path

A fact is one row with one ULID. A filing is an edge from a path to that fact, and one filing is marked **primary**. "Use the outbox pattern to send a webhook" is filed under `messaging` and under `database`, and it is one fact in both places.

The primary filing decides where the fact is written on export and how it is displayed. Every other filing is an index edge. This is why the write path resolves several paths for one memory rather than one, and why the count of them is capped.

## Scopes

| Scope      | Lifetime      | Owner              | Ships |
| ---------- | ------------- | ------------------ | ----- |
| `session`  | one run       | the run            | yes   |
| `feature`  | one objective | the objective      | yes   |
| `project`  | indefinite    | one project        | yes   |
| `personal` | indefinite    | the daemon's human | yes   |
| `team`     | indefinite    | a team             | no    |
| `company`  | indefinite    | an organisation    | no    |

`session` and `feature` are short-term. `project`, `personal`, `team` and `company` are long-term.

`team` and `company` are in the closed set and in the schema, and every route refuses them with `422`. The daemon serves one user, with one bearer token and no user model, per the non-goals of [../README.md](../README.md). A second user is what makes those two scopes mean something, and inventing an authorization lattice before that user exists produces the wrong one. They are named here so a later row is a row and not a change to the segment grammar. Until then the product has four scopes, and this file does not pretend otherwise.

## What memory never becomes

- **Memory is never a second trace store.** `attempt`, `agent_invocation`, `blob` and `event` hold the traces, they are complete, and they are already replayable. A fact cites them; it never copies them.
- **Memory is never a contract.** It sets no field the resolver reads as configuration: no verification command, no timeout, no acceptance criterion. [read-path.md](read-path.md) places it below every contract channel. A fact has an internal shape — a `failure` fact carries a problem and a solution — and that shape never reaches the instruction compiler as a structured field.
- **Memory is never authored by the run that reads it.** An objective pins its recall when its workspace is created, on the rule of [read-path.md](read-path.md). An agent that could edit the instruction governing its own run is the defect `../phase-2/instructions-and-profiles.md` already refuses for the profile and for ambient files.
- **Memory is never a conversational surface.** No route accepts a prompt and returns prose. The classifier of [write-path.md](write-path.md) accepts a candidate and returns paths from the existing registry. It creates no vocabulary and it never writes. This narrows the refusal recorded in `../after-the-mvp.md` rather than dodging it, and [write-path.md](write-path.md) states the amendment in full.

## The model is optional, and the difference it makes is stated

With no classifier registered the write path still files every memory the deterministic router can place, and the read path recalls at full function. Memory costs zero tokens in that configuration.

It is not the same system. Without a classifier, a candidate whose wording shares no term with any topic lexicon is filed as `unclassified` rather than filed correctly. `unclassified` is a real state: the fact is stored, it is recalled by direct query, and it appears in the curation queue. It is not a refusal and nothing is lost.

The classifier's job is exactly one thing: place a candidate the lexical router cannot place. Everything else — the closed vocabulary, the caps, the scope rules, the ordering, the dedupe — is deterministic and the model never touches it.

## Two consumers, one store

| Consumer           | Reads through                                        | Chooses the paths with |
| ------------------ | ---------------------------------------------------- | ---------------------- |
| A KanthorD attempt | the recall instruction channel, pinned per objective | the deterministic rank |
| A foreign harness  | the exported markdown tree, or the HTTP read routes  | its own model          |
| A human at the CLI | the catalog, a query, or the model-assisted mode     | either                 |

A foreign harness is Claude Code, Codex, or anything else that reads files. It gets a catalog file and one file per fact, and it needs no client and no integration. [portability.md](portability.md) holds the format and the routes.

Issue #21 asks for a model to choose domains, topics and facts on read. [read-path.md](read-path.md) ships that as a selection mode. It is not the default for an attempt, and that file says why.

## Determinism

The rules of `AGENTS.md` apply, and the honest statement of them is narrower than "relevance is deterministic".

Relevance is `-bm25()`, defined once in [vocabulary.md](vocabulary.md). It depends on statistics over the whole index, so a fact written later changes the relevance of a fact written earlier even when a filter excludes the later one. Three decisions follow.

- **A task's recall is computed once, before its first attempt, and stored.** Every attempt of that task renders the stored set. A fact written after the pin cannot change what that task reads, in content or in order. [read-path.md](read-path.md) says why the pin is per task rather than per objective, and what that costs.
- **A test asserts an order and an admission decision, and a relevance rounded to a fixed precision.** An exact float is coupled to the SQLite build, the tokenizer configuration and the query construction, and Node's bundled SQLite is not a version pin. The rounded relevance is asserted; the raw float is recorded.
- **The scorer version is recorded with every stored recall, every filing and every admission decision.** [vocabulary.md](vocabulary.md) defines it as the hash of exactly four inputs and is the only definition. A change to any of them is a scorer version change, and it never rewrites a stored result.

The classifier response is a nondeterministic input, and it is treated as one. It is stored by content address with the candidate, exactly as a rendered prompt is stored with an attempt, so a replay replays the decision rather than re-deriving it.

Beyond scoring, the ordinary rules hold without exception: the export is byte-identical for a given store state, paths sort bytewise through `Buffer.compare`, ties break by fact ULID ascending, and the canonical fact body is serialized once per `../phase-1/plan-format.md`.

## Files

| File                               | Subject                                                                |
| ---------------------------------- | ---------------------------------------------------------------------- |
| [vocabulary.md](vocabulary.md)     | domain, topic, the lexicon, the budget, proposals, curation, lifecycle |
| [write-path.md](write-path.md)     | capture, routing, the classifier, admission, filing, failure facts     |
| [read-path.md](read-path.md)       | the catalog, recall, ranking, conflict, the instruction channel        |
| [architecture.md](architecture.md) | tables, interfaces, the transaction timeline, concurrency              |
| [portability.md](portability.md)   | the markdown tree, the frontmatter, the routes, import                 |

## What this changed elsewhere

Two files outside this directory carry the decisions this subject depends on. Both are amended, and neither amendment is silent.

- `../phase-2/instructions-and-profiles.md` holds the recall channel, its precedence, the bounded-set budget rule and the `re@1` exclusion. [read-path.md](read-path.md) states what those rules mean for a reader.
- `../after-the-mvp.md` narrows the conversational-surface refusal to admit a fixed-purpose inference service, under five clauses. [write-path.md](write-path.md) states which clause the classifier satisfies.

## Verification

`npm run verify` covers memory with no model and no network.

- Path tests: a segment outside its registry is refused at construction; the renderer produces one byte sequence per path; a `team` or `company` scope is refused by every route.
- Vocabulary tests: a domain beyond the cap is refused and recorded as a proposal; a topic declared with no description is refused; a non-canonical slug is refused; a merge re-files every filing of the merged topic; a rename leaves stored recalls unchanged.
- Lexicon tests: the tokenizer, the query construction and the escaping are asserted against fixed inputs, including hyphens, punctuation, non-ASCII and an FTS operator in the candidate text.
- Relevance tests: `relevance = -bm25()` is asserted against a fixed corpus, so a better match carries the larger number; a candidate matching one high-frequency term nominates nothing; a candidate matching one rare term nominates that topic; a nomination below half the best relevance is dropped; nominations are ordered by relevance then topic slug bytewise.
- Admission tests: a classifier path naming a topic outside the registry is discarded; a classifier path the router did not nominate is still admitted, and its relevance is recorded; admission runs over the union of existing and proposed filings, so a repeated candidate never exceeds the filing cap and never carries two primaries; a candidate with no admitted path becomes `unclassified` and is never refused.
- Dedupe tests: the same canonical payload under the same scope, owner and kind adds a citation and inserts no second fact; the same payload under a different owner is a different fact; two `failure` facts sharing a body but differing in `solution` are two facts.
- Classifier tests against a fake transport: a two-stage call requests domains then topics; a malformed response is discarded whole and the write completes; a timeout leaves the router filing intact; the classifier cannot create a domain or a topic.
- Recall tests: the three-component ordering key is asserted whole, including a relevance tie broken by scope tier and a scope tie broken by ULID; a `session` fact never reaches a `project` recall; a fact written after a task's pin never reaches any attempt of that task, including a fact written by another objective; a `feature` fact filed by task one is read by task two of the same objective.
- Conflict tests: two facts marked `contradicts` are both returned and both marked disputed; a pair that does not fit the budget returns neither and reports the omission; a `personal` fact is excluded only when a `project` fact contradicts or supersedes it, and never for merely sharing a topic; nothing but a human creates a relation.
- Channel tests: a fact larger than the channel budget is refused at write, so recall cannot render an empty channel; a fact that does not fit is skipped and the next one is considered; `re@1` receives no recall channel; the budget is measured on the rendered block.
- Export tests: byte-identical output across two runs; a non-ASCII path ordered by `Buffer.compare`; a filename collision resolved deterministically; an import round-trips the export; an import of a tree with two divergent copies of one fact is refused.
- Draft and retention tests: a machine capture writes a `memory_candidate` inside the task transition, and a kill before the filing transaction loses nothing; a draft is never recalled, never filed and never rendered; only a human resolves a draft; a `session` fact is archived at run end and excluded from recall; an archived fact is deleted after its retention window; promotion never happens without a human.
- Inference tests: one `memory_inference` row per provider call, opened before dispatch; a kill between open and response leaves an open row naming the call; the `model` recall mode writes a row.
- Journal tests: replaying the journal rebuilds vocabulary, facts, filings, relations and the index byte-identically, including a rename, a merge, an archive and a deletion.
- Budget tests: a vocabulary mutation that would exceed the whole-catalog budget is refused before it commits; a registry at every cap renders inside the budget.
- Index integrity tests: `db status` reports a row whose content hash no longer matches its source, with the count unchanged.
- Portability tests: export refuses a manifested file whose hash changed, and `--force` names every file it overwrites; the catalog links the topic index and its count equals that index's entries; an import across daemons stores foreign provenance and refuses a `project` fact with no `--owner`.

## What a scenario must prove

The scenario ids belong to the phase that adopts this subject, so this file declares no id. A scenario must prove exactly what the unit suite cannot see: that a fact written by one attempt reaches a later objective through the real instruction channel across the process boundary, and that the exported tree on disk is what a second process reads.
