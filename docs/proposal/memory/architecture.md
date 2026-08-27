# Architecture

Reviewer: architect. The behaviour is [write-path.md](write-path.md) and [read-path.md](read-path.md). This file states where the code goes, what owns the transaction, and what happens when two writers meet.

`AGENTS.md` is the source of truth for structure. Nothing here widens it.

## Tables

| Table              | Holds                                                                                                          | Notes                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `memory_domain`    | slug, description, aliases, state                                                                              | `STRICT`                                  |
| `memory_topic`     | domain, slug, description, aliases, state                                                                      | `STRICT`                                  |
| `memory_fact`      | id, scope, owner, kind, body, payload hash, structured fields, state, occurrences                              | `STRICT`, id is `fact_<ULID>`             |
| `memory_candidate` | id, scope, owner, source, citation, source blob hashes, state                                                  | `STRICT`, written in the task transaction |
| `memory_filing`    | fact, topic, primary, admitted by, relevance, scorer version                                                   | `STRICT`                                  |
| `memory_citation`  | fact, node, run, attempt, actor, foreign provenance                                                            | `STRICT`                                  |
| `memory_relation`  | left fact, right fact, `contradicts` or `supersedes`, state                                                    | `STRICT`                                  |
| `memory_proposal`  | requested slug, count, motivating candidate, resolution                                                        | `STRICT`                                  |
| `memory_inference` | causing operation, call ordinal, registration, provider_model, request hash, response hash, opened at, outcome | `STRICT`, one row per provider call       |
| `memory_journal`   | sequence, act, subject, before, after, policy version                                                          | `STRICT`, append only                     |
| `memory_recall`    | task, query hash, ordered fact ids, rendered blob, scorer version                                              | `STRICT`, the pin                         |
| `memory_index`     | the FTS5 index                                                                                                 | **not** `STRICT`                          |

### The FTS5 exception

`../database/README.md` requires `STRICT` on every table. An FTS5 virtual table cannot be `STRICT`, so `memory_index` is the one exception, and it is granted on one condition: **`memory_index` is a derived index, never canonical data.** It holds no column that is not reconstructible from `memory_fact`, `memory_topic` and `memory_domain`.

A migration rebuilds it. `kanthord db status` compares **row identities and source-content hashes**, not row counts: every `fact` row must exist for an active fact and hash to that fact's canonical payload, and every `descriptor` row must hash to its topic's rendered descriptor. A mismatch is a repair, never a data loss, and nothing reads a fact body from it.

A count comparison was the first design, and it cannot discharge the condition this exception was granted on. Corrupt content keeps the count.

### The journal covers every act, not only admission

`memory_journal` is an append-only act log with a monotonic sequence assigned inside the write transaction. Every act that changes the taxonomy writes one row.

| Act          | Subject             | Records                                                  |
| ------------ | ------------------- | -------------------------------------------------------- |
| `admit`      | a candidate         | nominations, relevances, the admitted union, the outcome |
| `vocabulary` | a domain or a topic | declare, rename, merge, split, deprecate, remove         |
| `proposal`   | a proposal          | raise, increment, accept, merge, reject                  |
| `relation`   | a fact pair         | contradict, supersede, dismiss                           |
| `lifecycle`  | a fact              | archive, delete, promote, draft, resolve draft           |
| `import`     | a fact              | create, supersede, refuse                                |

Replaying the journal rebuilds `memory_domain`, `memory_topic`, `memory_fact`, `memory_filing`, `memory_relation` and the index. That is what makes a policy change safe: the rule changed, the history did not.

A log of admission alone was the first design, and three statements disagreed about it — the README promised every curation act, the table had columns for none of them, and the retention rule separately claimed a deletion was recorded. Replay could not reconstruct a rename, a merge, an archive or a deletion, so the projection claim was false for everything except facts and filings.

## Modules

The import matrix decides these placements, not convenience.

```
domain/memory-path.ts          the typed segment tuple and its one renderer
domain/memory-fact.ts          fact kinds, the required fields per kind, the canonical body
domain/memory-admission.ts     the pure admission predicate over score records
domain/memory-catalog.ts       the catalog projection and its byte budget
domain/memory-recall.ts        ordering, the scope tie-break, the dispute pairing, the skip rule

services/memory/index.ts       the store interface
services/memory/sqlite.ts      node:sqlite and every FTS5 query
services/classifier/index.ts   the classifier interface
services/classifier/pi-ai.ts   the implementation

commands/memory/remember.ts    capture through file
commands/memory/promote.ts
commands/memory/forget.ts
commands/memory/resolve-proposal.ts
queries/memory/catalog.ts
queries/memory/recall.ts

http/contract/memory.ts
http/server/memory/*.ts
cli/memory/*.ts
```

`domain/` stays pure. It receives plain immutable score records and returns decisions. It never sees SQLite, never builds an FTS query and never knows what a tokenizer is. Everything vendor-specific — the `MATCH` expression, the escaping, the `bm25()` call, the document-frequency lookup — lives in `services/memory/sqlite.ts`, which is the only file that imports `node:sqlite` for this subject.

```ts
export type TopicScore = Readonly<{
  topic: MemoryPath;
  score: number;
  matchedTokens: readonly string[];
  rarestTokenDocumentFrequency: number;
}>;

export function admit(
  policy: AdmissionPolicy,
  nominations: readonly TopicScore[],
  classifierPaths: readonly ClassifierPath[],
): AdmissionResult;
```

`admit` is pure, total and exhaustively tested. It is where the floors, the filing cap, the primary choice and `unclassified` are decided.

## The transaction timeline

The transaction belongs to storage, and one command is one transaction. A model call never runs inside one.

```
0  capture           insert memory_candidate              inside the task transition transaction
1  claim             read the candidate, validate         short read
2  nominate          read-only relevance                  short read
3  classify          the model call                       no transaction, possibly seconds
                     memory_inference opened before dispatch, completed after
4  file              BEGIN IMMEDIATE                      one write transaction
     4a  re-nominate against the state being written
     4b  re-run admit over the union of existing filings and the step 3 paths
     4c  dedupe on (scope, owner, kind, payload hash), insert fact, reconcile filings, write index rows
     4d  append memory_journal, append event, close the candidate
   COMMIT
```

Step 0 is durability. A machine capture persists inside the transaction that moves the task, so a crash before step 4 loses nothing and the next sweep resumes from the row. Deriving the candidate outside a transaction at the moment of the transition was the first design, and it lost the memory on any crash.

Step 4a is the correction to the design that admitted on relevance taken at step 2. The corpus moves between step 2 and step 4 — another worker files a fact, an archive runs — and a filing must be justified by the state it is written into. The classifier's paths are carried forward unchanged, because they were never relevances.

`services/memory` accepts the transaction context in every persisting signature, exactly as `services/event` and `services/lease` do. It imports the storage **interface** and never a storage implementation.

## Concurrency

SQLite serializes writers. That helps only for the decisions re-made inside the transaction, so each of these is named.

| Race                                            | Resolution                                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Two workers file the same payload               | the `(scope, owner, kind, payload hash)` unique index; the loser adds a citation                                                                |
| Two workers file the same fact at the same path | the `(fact, topic)` unique index; the loser is a no-op                                                                                          |
| Two proposals take the last registry slot       | only a human creates vocabulary, and the create is one transaction that re-checks the cap                                                       |
| A classifier call is retried                    | the idempotency key on the causing operation; the open `memory_inference` row is completed rather than duplicated                               |
| A retry re-files an already-filed candidate     | `memory_candidate` carries the state, and step 4d closes it; a repeat finds it closed, is a no-op, and the occurrence count does not move twice |
| Two candidates race the filing cap of one fact  | admission runs over the union inside the transaction, so the second writer sees the first writer's filings                                      |
| Index rows lag their fact                       | impossible: the index write is in the filing transaction                                                                                        |
| An archive runs while a promotion is in flight  | promotion re-reads the fact state inside its transaction and refuses an already-deleted fact                                                    |
| A supersession races a contradiction            | both are relation inserts, ordered by the transaction; a superseded fact leaves the dispute automatically                                       |
| An import races an ordinary write               | import takes one transaction per fact and re-checks the payload hash; a fact changed since the export is refused, naming the id                 |
| An export races a write                         | export reads one snapshot in one read transaction                                                                                               |
| A task pins a recall while facts are written    | the pin is one transaction taken before the task's first attempt, so it is a consistent read                                                    |

The memory watermark on a task is the commit order of `memory_journal`, not a ULID and not a wall clock. A ULID encodes when an id was minted, and a fact minted before a pin can commit after it. `memory_journal` has a monotonic sequence assigned inside the write transaction, and the watermark is that sequence.

## Deferred: rebuilding the taxonomy in place

`memory_journal` makes a rebuild possible. The command that performs one — replay the log under a new policy version, write a new projection, swap it — is not specified here. It needs a generation, a swap and an answer for a reader mid-recall, and no policy has changed yet. Specify it against the first real policy change.
