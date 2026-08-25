# Vocabulary

Reviewer: architect and AI engineer. The model is [README.md](README.md). This file defines the domain, the topic, the lexicon that generates candidates, and the budget that keeps the catalog readable.

## A domain and a topic are declared by a human

There is one registry for the daemon, and scope is a property of the fact rather than of the registry. [README.md](README.md) says why.

A domain is a row. A topic is a row under a domain. Both carry a slug, a one-line description and a set of aliases.

```
domain  backend-developer  "Server-side application work: services, data, transport."
  topic messaging          "Queues, brokers, webhooks, delivery guarantees."
        aliases: queue, broker, webhook, pubsub, event bus
  topic database           "Schema, query, transaction, storage engine."
        aliases: sql, columnar, index, migration
```

The slug is canonical: lower case, ASCII, hyphen separated, singular, at most 40 bytes. The renderer refuses anything else, so a path segment cannot become free-form text.

The description is mandatory and at most 120 bytes. It seeds the lexicon, and it is the line a reader sees in the catalog. One field does both jobs, so a topic that is hard to describe is a topic that routes badly, and the writer finds that out at declaration time.

**Only a human creates a domain or a topic.** The classifier of [write-path.md](write-path.md) requests one and never creates one. A model that could create vocabulary would consume the whole budget before a human ever read the catalog, which is the failure the budget exists to prevent.

## The budget

Two budgets, and they bound different things.

| Budget                        | Default | Bounds                                 |
| ----------------------------- | ------- | -------------------------------------- |
| whole catalog bytes           | 48 KiB  | the export, and a stage-one selection  |
| catalog slice bytes           | 12 KiB  | one classifier call                    |
| domains in the registry       | 12      | what a human curates                   |
| topics per domain             | 12      | what a human curates                   |
| filings per fact              | 3       | how wide one memory spreads            |
| fact body bytes               | 2 KiB   | one fact against the recall channel    |
| facts per topic before review | 200     | when a human is asked to split a topic |

The registry caps are the curation bound, and they are what a human reasons about. The byte budgets are the machine bound.

**The two must agree, and the first pair did not.** A 16 KiB catalog was declared beside caps that permit 144 topic lines; at the caps — a 40-byte slug and a 120-byte description, plus the link and the count — a line runs to roughly 260 bytes, so a registry curated strictly inside every stated cap renders about 37 KiB. Even with short slugs and half-length descriptions it passes 20 KiB. The budget forbade what the caps allowed, so a legal store had an unrenderable catalog. 48 KiB is the bound the caps can actually reach.

The slice budget is the one that reaches a prompt. The classifier of [write-path.md](write-path.md) never receives the whole catalog: call one gets the domain list, which is 12 lines, and call two gets the topics of at most three returned domains, which is at most 36 lines. 12 KiB covers that with headroom.

**Every vocabulary mutation checks the rendered size before it commits**, and it is refused if it would exceed the whole-catalog budget. Checking only at render was the first design, and it let a store reach a state where `memory.catalog` fails and stage one stops working. Fact counts change on every write and are not re-checked; the budget reserves headroom for count digits, which is the only growth between mutations.

Every default comes from configuration. Twelve by twelve is a starting point, not a measured constant, and this file says so rather than dressing it as one. The measurement that would change it is in [write-path.md](write-path.md): a rising `unclassified` rate whose proposal rows name the same missing subject.

A cap never refuses a fact. A candidate that cannot be placed becomes `unclassified` and is still stored. [write-path.md](write-path.md) holds that rule.

## Proposals

A proposal is a row: the requested domain or topic, the candidate text that motivated it, the paths the router preferred instead, and the fact that was filed. A human resolves it.

| Resolution | Effect                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------- |
| `accept`   | the domain or topic is created, and every `unclassified` fact that motivated it is re-routed |
| `merge`    | the proposal folds into a named existing topic, whose aliases gain the slug                  |
| `reject`   | the proposal closes, and the filing already made stands                                      |

`accept` at the cap is refused until the human removes or merges an existing entry. The cap is the point; a route that silently raises it deletes the design.

A proposal is recorded once per requested slug. A second candidate wanting the same missing topic increments its count, and the count is what tells the human the topic is real.

## Vocabulary lifecycle

A registry that only grows is not curated. Five operations exist, all human-driven, each one transaction.

| Operation   | Effect on filings                                       | Effect on a stored recall |
| ----------- | ------------------------------------------------------- | ------------------------- |
| `rename`    | filings follow the row; the old slug becomes an alias   | none                      |
| `merge`     | every filing of the source moves to the target, deduped | none                      |
| `split`     | the human names the target topic per filing             | none                      |
| `deprecate` | the topic accepts no new filing; existing filings stand | none                      |
| `remove`    | refused while any filing exists                         | none                      |

A stored recall is never rewritten. It holds fact ids and rendered text, and the vocabulary that produced it is history. An objective that pinned its recall last week resolves to the same bytes after a rename, for the same reason a `check_result` recorded last month still names the exact command that ran then.

`split` is manual. Splitting a topic by clustering its facts is deferred until a real registry reaches the review limit and the counts are in hand.

## The lexicon generates candidates

Issue #21 asks how to measure that a sentence is relevant to a domain. The honest answer is that `bm25()` does not measure that. It ranks documents that share terms with a query. It is not a calibrated membership probability, and treating it as one was the first design's error.

The lexicon is therefore **candidate generation**. Admission is a separate decision, and [write-path.md](write-path.md) owns it.

### The index

One FTS5 table, `memory_index`, with one row per indexed document.

| Document kind | One row per | Content                                           |
| ------------- | ----------- | ------------------------------------------------- |
| `descriptor`  | topic       | domain slug, topic slug, every alias, description |
| `fact`        | fact        | the canonical fact body                           |

A concatenated document per topic was the first design and it was wrong twice. Term frequency saturated as facts repeated, document length grew without bound, and every filing rewrote the whole document, which is write amplification on the hot path.

### Relevance

`bm25()` returns a rank where a **smaller** number is a better match, and a better match is a more negative number. Every threshold and every sort in this design is stated against

```
relevance = -bm25()
```

so a larger relevance is a better match and relevance is positive for any row that matched. The word "score" is not used. Leaving the sign undefined was the first design, and it made "the maximum", "at least half the best" and "descending" each ambiguous or meaningless — half of a negative number is larger than it.

A topic's relevance to a candidate is the **maximum** relevance over its `descriptor` row and its `fact` rows. Maximum, not sum, because a topic with two hundred facts must not outrank a topic with two on volume alone.

### The query

Exactly specified, because "canonical tokenization" is not a specification.

- Tokenizer: `unicode61 remove_diacritics 2`, with the default separator set. No stemming. The same tokenizer indexes and queries.
- The candidate text is tokenized, every token shorter than 3 bytes is dropped, and the daemon's fixed stop list is applied. The stop list is content shipped with the binary, and it is versioned.
- Every remaining token is quoted, so an FTS operator inside a candidate is a literal. A candidate that reduces to no token nominates nothing.
- The tokens join with `OR`. `AND` would let one unusual word suppress the whole query.
- The query is capped at 64 tokens, rarest first by document frequency, so a long candidate does not become a query that matches everything.

The **scorer version** is the hash of exactly four inputs, in this order, and of nothing else:

1. the tokenizer configuration;
2. the stop-list version;
3. the query construction version;
4. `sqlite_version()`.

It is recorded with every stored recall, every filing and every admission decision. Two different lists appeared in the first design, in this file and in `README.md`, and a version derived from two different input sets is not a version. [README.md](README.md) holds the determinism consequences.

### The two floors

The router nominates a topic when both hold:

- the match includes at least one token whose document frequency is below the daemon's commonness threshold — one rare token is enough, and a hundred common ones are not;
- the topic's relevance is at least half the best topic's relevance.

The first floor replaced "at least two distinct terms", which rejected a candidate carrying one decisive rare word and admitted a candidate carrying two useless common ones. Document frequency is what separates a decisive term from a common one, and the index already holds it.

The second floor keeps the nomination list short before admission. It is a heuristic and this file calls it one. It is not a confidence, it is not calibrated, and correctness is decided at admission rather than here.

### What the lexicon does not do

- **It does not handle paraphrase.** "Persist the event atomically with the row" and "send a webhook through an outbox table" share no useful token. The router will not place the first one. The classifier will, and that is the classifier's only job.
- **It does not sharpen a topic's boundary.** Facts added to a topic add vocabulary. They do not clarify where the topic ends. The claim that the taxonomy learns without a training step was false and it is withdrawn.
- **It does not stop a topic becoming a lexical sink.** A topic with wide vocabulary matches wide. The review limit flags it and a human splits it. Nothing automatic protects against this, and pretending otherwise would hide the one operation that fixes it.
- **It does not rank a short fact fairly against a long one.** BM25 length normalisation favours a terse general statement. The fact body cap narrows the range; it does not remove the effect.

### Why not embeddings

An embedding would place a paraphrase with no model call at write time. It costs an embedding provider, a vector index, and a pinned model whose replacement re-scores the whole store. This design uses a classifier call instead, because the classifier is auditable, its response is stored by content address, and a provider change is a recorded input rather than a silent re-ranking.

Revisit against the measurement in [write-path.md](write-path.md), not against an anecdote.

## Seeding

An empty registry routes nothing, so the daemon ships a seed vocabulary: a small set of domains and topics with descriptions and aliases, instantiated at onboarding, in the pattern of the repository template of `../phase-2/instructions-and-profiles.md`. The human edits it.

The seed is content shipped with the binary. It is not a table and not a row, on the same rule that makes a repository template content rather than data.
