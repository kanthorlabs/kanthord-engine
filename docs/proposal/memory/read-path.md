# Read path

Reviewer: AI engineer. The write path is [write-path.md](write-path.md). This file defines how a fact gets back to whoever needs it.

## Recall is two stages, because that is how a human recalls

```
catalog                    →   recall
what do I know about?          what exactly do I know?
```

The catalog is the card index: every domain and topic, each with its description and its fact count. It is bounded in bytes by [vocabulary.md](vocabulary.md), so it always fits, and it costs one indexed read.

Recall takes a query and a set of paths, and returns facts.

The split is the whole design. A reader that must choose is given a short list of subjects, not a corpus. A reader that already knows the subject goes straight to the facts.

## Who chooses the paths

Stage one has two selection modes, and the caller names one.

| Mode    | Chooses the paths with                                             | Model calls |
| ------- | ------------------------------------------------------------------ | ----------- |
| `rank`  | the router of [vocabulary.md](vocabulary.md), over descriptor rows | 0           |
| `model` | the classifier, given the catalog and the query                    | 1           |

`rank` scores the query against the `descriptor` row of every topic and takes the top paths that clear the floors. It reads no fact bodies, so stage one stays cheap.

`model` is what issue #21 asks for, and it ships. The classifier receives the catalog and the query and returns at most three topic paths from the registry. It selects; it never ranks facts and never writes.

A `model` selection is a provider call, so it writes a `memory_inference` row opened before dispatch and completed after, exactly as a write-path classification does. See [write-path.md](write-path.md).

| Caller             | Default | Why                                                                                                                                                 |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| A KanthorD attempt | `rank`  | recall is pinned per objective and rendered into every attempt, so a nondeterministic step in front of every run buys variance rather than accuracy |
| A human at the CLI | `rank`  | a human reads the catalog faster than a model call returns                                                                                          |
| An HTTP client     | named   | the caller decides                                                                                                                                  |

An attempt may use `model`, through configuration. The recall is pinned either way, so the model call happens once per objective and never once per attempt.

A foreign harness uses neither. It reads the catalog file and its own model picks the subjects. [portability.md](portability.md) gives it the tree and the routes.

## Stage two: ranking the facts

Recall scores the query against the `fact` rows of the index reachable from the selected paths, on the mechanism of [vocabulary.md](vocabulary.md). Stage one scores descriptors because it is choosing a shelf; stage two scores fact bodies because it is choosing a book.

Three filters apply before ranking, and none is a score.

- **Scope.** A recall names its scopes. A `session` fact never reaches a recall that did not name that session. A `feature` fact never reaches another objective.
- **Lifecycle.** A superseded fact, an archived fact and every draft are excluded. The superseding fact is returned in place of the superseded one.
- **Pinning.** For an attempt, the pin is the whole mechanism, and the section below replaces this filter.

### The ordering key

One key, three components, applied in this order and no other.

| Position | Component  | Direction  | Source                                                    |
| -------- | ---------- | ---------- | --------------------------------------------------------- |
| 1        | relevance  | descending | `relevance = -bm25()`, per [vocabulary.md](vocabulary.md) |
| 2        | scope tier | ascending  | `session` 0, `feature` 1, `project` 2, `personal` 3       |
| 3        | fact ULID  | ascending  | the identity                                              |

Relevance is primary, scope breaks an equal relevance, and the ULID breaks the rest. The key is total, so two correct implementations return the same facts in the same order.

Two partial keys four lines apart were the first design — one breaking a tie by ULID and one breaking the same tie by scope — and a document whose rule is that every statement is a decision cannot carry both.

Scope as the **primary** component was the design before that, and it was worse: a weak `session` match consumed the whole budget ahead of a strong `project` fact. Specificity breaks a tie. It is not a licence to outrank a better answer.

### Scope decides a conflict, not a rank

**A `personal` fact is excluded when an active `project` fact contradicts or supersedes it.** The project established something the personal fact disagrees with, and a personal preference must not displace a project decision.

The exclusion needs the relation. Excluding every `personal` fact under a topic that holds any `project` fact was the first design, and it was far too coarse: a topic is deliberately broad, so one project fact under `messaging` hid every unrelated personal fact filed there. The `contradicts` and `supersedes` relations of [write-path.md](write-path.md) already model the only case the rule exists for, and confining the override to a declared disagreement costs nothing and reuses what is there.

### A disputed fact brings its opposite

A fact in an active `contradicts` relation is disputed, per [write-path.md](write-path.md). When recall returns one side, it returns the other side too, adjacent and marked, and both count against the budget together. If the pair does not fit, neither is returned and the omission is reported.

Returning one half of a live disagreement is the worst available answer, because the reader cannot tell that a disagreement exists.

## The recall instruction channel

`../phase-2/instructions-and-profiles.md` compiles instruction into typed channels. Memory adds one.

```
daemon invariants
role contract
repository profile
project policy
task contract
recalled memory      ← new
ambient context
runtime evidence
```

It sits below every contract channel. Memory is advisory prose with a citation. A fact that could override the task contract would be a way for last week's work to redefine this week's.

### The budget rule is a bounded set

`../phase-2/instructions-and-profiles.md` states that a channel over its budget refuses the attempt, and that ambient context is the only channel the resolver may drop. Recall fits neither rule, and calling budget-caused omission "selection" rather than "truncation" would not have resolved the conflict. That file therefore carries the rule, and this is what it says.

**Recalled memory is a bounded-set channel.** The resolver renders facts in rank order and **skips** any fact whose rendered block would exceed the remaining budget, continuing with the next one until the list is exhausted. It never truncates a block, and it never refuses the attempt. The count considered, the count rendered and the ids skipped are recorded on the attempt. A single fact can never exceed the whole channel budget, because [write-path.md](write-path.md) refuses a body over the cap at write time. The budget is measured on the **rendered** block — the fact body, its path, its id, its citation and the block framing — not on the canonical body. A compiled channel that still exceeds its budget is a defect, and it refuses the attempt like any other channel.

Skip rather than stop, because stopping at the first fact that does not fit discards every smaller fact behind it for no reason.

### The remaining three rules

- **It sets no structured field.** Same rule as ambient context, same reason. A `failure` fact renders its problem and solution as prose.
- **It is pinned per task, before that task's first attempt.** The task records its recall in one transaction before it is first attempted, and every attempt of that task renders the stored set. A fact written after the pin is invisible to that task — including one written by another objective, which matters because a later write moves `bm25()` statistics under an unpinned query. The pin stores the result rather than the query, and that is what makes the recall reproducible.
- **`re@1` receives no recall channel.** The reviewer renders from a reduced prompt and never sees implementation guidance, because a reviewer that reads what the implementer read makes correlated mistakes. Every fact is implementation guidance by the definition of this channel; anything that governs rather than advises belongs in the repository profile or the project policy, and a memory that wants to be policy is a profile edit. The exclusion is the existing rule applied, and it is not split by fact kind.

Every rendered fact carries its path, its id and its citation, so `kanthord instructions resolve` shows per-block provenance for memory exactly as it does for every other channel.

## The query for an attempt

The query is the task body: its title, its description and its acceptance criteria. It is not the diff and it is not the tool trace. The task body is what the work is about, and it is fixed before the attempt starts, which is what makes the recall reproducible from the attempt record.

### Why the pin is per task and not per objective

Pinning every recall at workspace creation was the first design, and it made `feature` scope unreadable. A task outcome is filed at `feature` when a task reaches `done`, which is after every pin of that objective was taken; the scope is then archived when the objective terminates, and no other objective may read it. Nothing could ever read it, and because promotion is nominated only for a fact that was recalled at least once or is a `failure`, no ordinary feature fact could ever be promoted either. The scope was a dead end in both directions.

Pinning before each task's first attempt fixes it. Two tasks in one objective share a working tree and are serialized, per `../open-items.md`, so task two pins after task one finished and reads what task one filed. That is what `feature` scope is for.

The cost is stated rather than hidden: **an agent working task one can influence the instruction of task two inside the same objective.** The guarantee that survives is the one that matters — an agent cannot change the instruction governing its own run, because a task's recall is fixed before its first attempt and every attempt of that task renders the same bytes. The profile hash still pins at workspace creation; memory pins later, because the two protect different things.

## Reporting a recall

Recall returns, for every fact: the rank, the rounded relevance, the matched tokens, the scope tier, the selection mode, the dispute state, and the scorer version. It returns the count considered, the count rendered and the ids skipped.

A retrieval nobody can explain is a retrieval nobody can fix, and the matched tokens are recoverable from the query at no cost.

`kanthord memory recall --query <text>` prints the same report, so a human debugs a bad recall without running an attempt.

## Deferred: usage feedback

Which recalled facts an attempt actually used is not measured. It would need the agent to cite, and a citation an agent produces is a claim rather than a measurement. Recall count is tracked, because the daemon writes it. Usefulness is not, because nothing can currently observe it. Revisit when an attempt produces a structured citation for another reason.
