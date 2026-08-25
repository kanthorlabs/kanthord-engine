# Write path

Reviewer: AI engineer. The vocabulary is [vocabulary.md](vocabulary.md). This file defines how a candidate becomes a filed fact.

## Five stages

```
capture → nominate → classify → admit → file
          (rules)    (model)    (rules) (one transaction)
```

`classify` is skippable. With no classifier registered, or with its budget spent, or on a timeout, the write completes on `nominate` and `admit` alone. Nothing waits on a model, and nothing fails because of one.

The division of labour is fixed. The model decides **where a candidate belongs**. The rules decide **what is legal**: the registry is closed to it, the caps bind it, the scope rules bind it, and it never writes. The rules do not overrule the model on meaning, because the model is present precisely for the cases the rules cannot read.

## Capture

A candidate is a text plus a citation. There are three sources, and no other.

| Source            | Trigger                                               | Scope default | Produces |
| ----------------- | ----------------------------------------------------- | ------------- | -------- |
| Human             | `kanthord memory remember`, or `memory.remember`      | `personal`    | a fact   |
| Task outcome      | a task reaches `done`                                 | `feature`     | a draft  |
| Recovered failure | a task is rejected, then accepted inside the same run | `project`     | a draft  |

The daemon never harvests a tool call, a file read, a heartbeat or a lease renewal. Those are in the attempt record already, they are complete there, and a second copy of them under a different name is the mistake this design exists to avoid.

A candidate carries its citation: the node id, the run id and the attempt id it came from, or the actor id of the human who wrote it. A candidate with no citation is refused.

A candidate body over the fact body cap of [vocabulary.md](vocabulary.md) is refused at capture, naming the cap. This is what makes the recall channel of [read-path.md](read-path.md) unable to render empty.

### An automatic capture is durable before it is processed

A machine capture writes a `memory_candidate` row **inside the transaction that moves the task**, holding the scope, the citation and the exact source references — the blob hashes of the reviewer reason, of the diff and of the task body. Nothing is derived at that moment, and nothing is hashed.

Processing happens later, from the row. A crash between the task transition and the filing transaction therefore loses nothing: the candidate is already durable, and the next sweep picks it up.

Deriving the candidate at the moment of the transition, outside a transaction, was the first design. It lost the memory on any crash, and it never said what the candidate text was.

### A machine capture is a draft, and a draft is not a fact

A task rejected and then accepted inside one run produced a problem and its solution, and the daemon holds both halves: the `re@1` reason of the last rejection, and the diff of the attempt that passed. A task that reached `done` on its first attempt produced a task body and an accepted diff.

Those are evidence, not a memory. Turning "the reviewer said the handler swallows the error" and a 40-line diff into "write the event to an outbox table in the same transaction" is summarisation and judgement, and the daemon performs neither. The earlier claim that a failure fact is captured with no model call and no judgement was impossible, and it is withdrawn.

The daemon therefore writes a **draft**, which is a candidate that names its evidence and asserts nothing.

| Draft source      | `problem`                             | `solution`                             |
| ----------------- | ------------------------------------- | -------------------------------------- |
| Recovered failure | the verbatim `re@1` rejection reason  | the object ids of the diff that passed |
| Task outcome      | the verbatim task acceptance criteria | the object ids of the accepted diff    |

A draft is stored, it is listed in the curation queue, and **it is never recalled, never filed at a path, and never rendered into an instruction channel**.

**A human resolves a draft into a fact**, through `memory.draft.resolve`. The classifier does not, and cannot: the exception at `../after-the-mvp.md` requires its output to be a value from a registry-validated set and requires it to write nothing, and a concise `problem` and `solution` pair is prose and a write. A service that resolved drafts would fail two clauses of the exception it depends on.

A draft nobody resolves within its retention window is deleted with its scope. That is a real loss of a lesson, and it is the accepted cost of refusing to let a model author memory unattended.

### Deferred: agent-authored draft resolution

An agent could resolve a draft, and it would be legitimate under the original invariant rather than the narrowing: an agent invocation attributed to a node, a run and an attempt, replayable from its blobs. It needs a node to attribute to, and a draft is not work in the graph. Design it against the first graph node that exists for the purpose.

### Fact kinds

| Fact kind    | Required                    |
| ------------ | --------------------------- |
| `note`       | body                        |
| `preference` | body                        |
| `procedure`  | body, ordered steps         |
| `failure`    | body, `problem`, `solution` |

A `failure` fact with an empty `problem` or an empty `solution` is refused. The pattern is the value, so half of it is not a smaller memory, it is a different and useless one.

These fields are the fact's internal shape. None of them reaches the instruction compiler as a structured field; [read-path.md](read-path.md) renders them as prose.

## Nominate

The router scores the candidate text against the index of [vocabulary.md](vocabulary.md) and returns every topic that clears the two floors, ordered by score then by topic slug bytewise.

A nomination is not a filing. It costs zero tokens and it runs on every candidate.

## Classify

The classifier is a service. It holds no tool set, no workspace and no turn loop, it never writes, and it never creates vocabulary.

It runs in two calls, which is what issue #21 describes as drilling down and which also keeps each request small.

1. **Domains.** Input: the domain list — slug and description only — and the candidate text. Output: at most three domain slugs, each either present in the list or marked as a request for a new one.
2. **Topics.** Input: the topics of the returned domains, and the candidate text. Output: at most three **topic paths** — a domain and a topic, and no fact segment — each either present in the registry or marked as a request.

A topic path is the two-segment address the router and the classifier both work in. A fact path adds the fact and appears only where a fact is identified, which is the export of [portability.md](portability.md). One address with an optional leaf, named consistently.

The catalog fits, because [vocabulary.md](vocabulary.md) caps it in bytes.

The response is schema-validated. A path naming a domain or topic that is absent from the registry, and not marked as a request, is discarded. A malformed response is discarded whole. A discarded response never fails the write.

The classifier is bounded per day by call count and by input tokens, from configuration. An exhausted budget skips the stage.

### What is recorded

**One row per provider call**, in `memory_inference`. The row is opened **before dispatch**, holding the candidate or query id, the operation that caused it, the registration, the `provider_model`, the request by content address and the call ordinal. It is completed after the response, with the response by content address, the latency and the outcome.

Opening before dispatch is the point. A row written only on completion leaves a crash mid-call with no trace of a provider call that happened and was billed, and the clause in `../after-the-mvp.md` requires a durable row per call rather than per decision.

Two calls therefore write two rows. So does the `model` selection mode of [read-path.md](read-path.md), which is a provider call on the read path and is audited identically.

An idempotency key on the causing operation stops a retry producing a second decision. Request and response blobs follow the retention of the attempt blobs they sit beside.

The rows are the audit record, and they are what makes a replay replay the decision instead of re-deriving it.

### Why this is not the refused conversational surface

`../after-the-mvp.md` refuses a conversational surface with a stated invariant: refuse any operation that invokes an agent outside a project, a run, a node, an attempt and a durable audit record.

Calling the classifier "a service, not an agent" is not an argument, because the invariant protects attribution and auditability rather than a component name. That file therefore carries a written narrowing, under five clauses: no tool and no shell, no workspace and no turn loop, an output from a closed or registry-validated set rather than prose, no write and no registry mutation, and a durable row per call naming the provider, the model, the request and response by content address, and the causing operation. A service that fails any clause is an agent, and the refusal stands.

The memory classifier satisfies all five, and it is the first service that does. `memory.remember` accepts free-form text from a human, and this is where that text may reach a provider: `memory_inference` records the call, the response is a topic path from the existing registry, and no vocabulary changes as a result.

## Admit

Nominations and classifier paths meet here. The rules decide what is legal, and they do not re-judge meaning.

| Origin                       | Admitted when                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------- |
| Human, path named explicitly | the path exists                                                               |
| Classifier                   | the path exists, and the scope rules allow the filing                         |
| Router                       | the path exists, and it cleared both floors of [vocabulary.md](vocabulary.md) |

A classifier path is admitted whether or not the router scored it, and the router's score for it is recorded. The first design made the classifier's proposal pass the lexical floor, which defeated the only reason the classifier exists: a paraphrase the router cannot see is exactly what it was asked to place.

Admission runs over the **union of the filings the fact already has and the paths admitted for this candidate**, never over the new paths alone. The union is ordered — classifier paths first, then router paths by relevance, ties broken by topic slug bytewise — truncated to the filing cap, and exactly one filing is marked **primary**. A filing dropped by the truncation is removed, and the removal is logged.

Admitting only the new paths was the first design, and it broke on the second occurrence of a recurring candidate: existing filings were never counted against the cap, so a fact accumulated filings without bound, and a second write marked a second primary while nothing cleared the first.

### `unclassified`

A candidate with no admitted path is filed as `unclassified`. It is not refused and it is not filed under a default topic.

- The fact is stored, with its citation and its scope.
- It is excluded from a path-scoped recall and returned by a direct query.
- It appears in the curation queue with its nominations, its scores and the classifier response if there was one.
- Accepting a proposal re-routes every `unclassified` fact that motivated it.

`unclassified` replaced an outright refusal. A refusal contradicted the rule that a cap never blocks a write, and it threw away the one signal that tells a human which subject the registry is missing. A `misc` topic was the other option, and that is where a taxonomy goes to die.

## File

One transaction, on the rule of `AGENTS.md`. [architecture.md](architecture.md) holds the timeline and the concurrency rules.

1. Canonicalize the **whole payload** — the body and every field the kind requires — and hash it. Hashing the body alone was the first design, and two `failure` facts sharing a first line but carrying different solutions collapsed into one, which destroys the pattern that makes a failure worth keeping.
2. Look for an existing fact with that payload hash under the same `(scope, owner, kind)`. On a hit, add the citation, increment the occurrence count, and continue with that fact.
3. Insert the fact if it is new. The fact id is a ULID. The payload hash is a content key, not the identity.
4. **Re-run the router inside the transaction** and re-apply admission over the union of step 5. Relevance taken before the model call is stale by the time the transaction opens, and a filing must be justified by the state it is written into.
5. Reconcile the filing rows to the admitted union, and mark exactly one primary.
6. Insert or update the `fact` row of the index.
7. Append the journal row and the event.

`owner` belongs in the dedupe key because `scope` is the kind of scope and not the owner of it. Two projects both write at scope `project`, so a key without `owner` collapses their identical text into one row belonging to whichever wrote first, and the owner-filtered read of the second project then misses its own fact entirely. `kind` stays in the key because identical prose recorded as a `preference` and as a `failure` is not one claim.

A fact is never edited. A correction is a new fact plus a `supersedes` pointer at the old one, exactly as a plan revision supersedes a plan revision. A superseded fact is excluded from recall and retained.

The occurrence count is evidence of recurrence. It never makes a fact true and it never promotes one.

## Contradiction

Supersession handles a correction the writer knows about. It does not handle two facts that disagree and both look current: "always publish through an outbox" and "do not use an outbox for this provider" can both be active, filed at the same path, cited by different work.

One relation exists, `contradicts`, and it is symmetric. **A human creates it, and nothing else does.** A fact in a `contradicts` relation with an active fact is **disputed**.

The classifier cannot create one. Its inputs are slugs, descriptions and the candidate text, and it never receives a fact body, so it cannot compare two facts. Supplying the bodies instead would break the two properties the classifier is built on: the request would grow with the topic's fact count, and the output would stop being a value from a registry-validated set. A first design let the classifier report an incompatibility it had no evidence for, and that is withdrawn.

Detection is therefore manual, and this design does not claim otherwise. A human reading a recall that returns two facts at one path is the mechanism, and the report of [read-path.md](read-path.md) is what makes that pair visible.

A disputed fact is still recalled, and [read-path.md](read-path.md) requires both sides to be rendered together. Letting rank silently return one side of a live disagreement is worse than returning neither, because the reader cannot tell that a disagreement exists.

A human resolves a dispute by superseding one side, by narrowing one side's body, or by dismissing the relation. The daemon resolves nothing.

No further relation ships. `supports` and a citation graph are a different product, and nothing in this design consumes them.

## Retention and promotion

A short-term scope ends. `session` ends when its run ends. `feature` ends when its objective reaches a terminal state.

At that boundary every fact in the scope is **archived**: excluded from recall, retained with its citations, still reachable by id. An archived fact is **deleted** when its retention window expires, from configuration, default 90 days. Memory that only accumulates is not memory, and the first design had no deletion at all.

A human deletes any fact at any time, through `memory.forget`. The decision log keeps the record that it existed and that it was deleted.

A fact is **nominated** for promotion at the archive boundary when either holds: it is a `failure` fact, or it was recalled at least once while the scope was live. A nomination is a row a human resolves.

Promotion is never automatic. A single task observation that could make itself a personal rule is the failure mode that makes a memory store untrustworthy, and no score threshold is worth it. Promotion creates a new fact in the destination scope, citing the archived fact, and leaves the archived fact archived.

## What is measured

The write path is judged on a labelled set: completed runs whose candidates a human has placed by hand. Precision alone is not a target, because a system that admits almost nothing reaches precision 1.00 and remembers nothing.

| Measure                                                        | Target                   |
| -------------------------------------------------------------- | ------------------------ |
| Filing precision: an admitted path the human agrees with       | ≥ 0.85                   |
| Path recall at 3: the human's path is among the admitted paths | ≥ 0.85                   |
| Coverage: candidates that reached at least one path            | ≥ 0.80                   |
| `unclassified` correctness: the human agrees no path fitted    | ≥ 0.70                   |
| Router path recall at 3, classifier disabled                   | reported, not a gate     |
| Failure drafts resolved into facts                             | ≥ 0.80 within the window |
| Duplicate facts under one path                                 | 0                        |
| Model calls per candidate                                      | ≤ 2                      |
| Model calls with no classifier registered                      | 0                        |

Router path recall with the classifier disabled is reported rather than gated, and it is the number that says what the model is buying. A gap that closes means the classifier can be switched off; a gap that widens means the registry is drifting away from the way work is described.

An `unclassified` rate is a diagnosis, not a failure. It says the registry is missing a subject, the proposal rows say which one, and lowering a floor to improve the number is how a taxonomy fills with noise.

## Deferred: harvesting the objective and the initiative

A task outcome is captured. An objective outcome and an initiative outcome are not. Both are aggregations, and an aggregation of facts that are already filed is a summary. A summary is a generated artifact, it needs a faithfulness gate, and it earns none of that until recall over the filed facts is measured and found short.
