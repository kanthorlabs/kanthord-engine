# Plan format

Reviewer: developer experience. Phase 1. This file describes what a human writes by hand, and what happens when they import it.

## Only a human mutates the graph

Through the HTTP API, or through export, edit and re-import. No agent changes the graph.

## Layout

Markdown with YAML frontmatter. The `yaml` dependency parses it. `zod` validates it.

```
plan/<slug>--<initiative-ulid>/initiative.md
plan/<slug>--<initiative-ulid>/<slug>--<objective-ulid>/objective.md
plan/<slug>--<initiative-ulid>/<slug>--<objective-ulid>/<NN>-<slug>--<task-ulid>.md
```

This layout is the human's own directory, and export writes it. The daemon stores no path.

Frontmatter fields: `id`, `kind`, `title`, `depends_on`, `worker`. An objective also carries `repo`. The body needs an `## Acceptance criteria` heading, because `re@1` judges against it. Everything before that heading is the instruction.

**`repo` holds the registered repository name, never its id.** A repository id is a ULID minted at registration, and a human authoring a plan by hand cannot know one — the same reason an authored document may lack identities and reference by path. Import resolves the name to the id, and `repository-unknown` names the unresolved name back.

**A translation that cannot resolve raises. It never falls back to the untranslated value.** Both directions carry this rule: import resolves a name to an id before it writes, and export and validate resolve an id back to a name before they emit. A miss in either direction means the database contradicts its own foreign key, so it is an invariant failure that names the value it could not resolve, never a pass-through. A fallback that emits the id where the format promises a name is the worse outcome of the two available: an export carrying an id round-trips as a _different_ plan, and `repo` is a field the byte-identical round-trip depends on. The lookup is expected to resolve for a database written only through the product's own connections, which is what makes a miss an invariant failure rather than a user error.

Import validates: schema, cycles, unresolved references, unknown worker kinds, unknown repositories, duplicate identities, a `repo` on a task, a missing `repo` on an objective, and empty parents. Validation collects every finding. It does not stop at the first one, because a human who edits a plan by hand wants one round trip.

## Identity

Node identity is a prefixed ULID in frontmatter, and the prefix is the kind: `initiative_<ulid>`, `objective_<ulid>`, `task_<ulid>`. A `depends_on` entry therefore names the level it points at. See [../database/node.md](../database/node.md). The file path is cosmetic, so a rename does not destroy a node.

`depends_on` accepts a relative file path before identities exist. Import resolves it, mints the identities, and returns a document that carries them with `depends_on` rewritten to identities. The client writes that document over its own copy. Resolution order is ULID first, then path. An unresolved or ambiguous reference fails the import.

## A plan document carries no state

Export writes no status field, and no route accepts one. A plan document holds the revisioned topology and prose, and nothing else.

State moves without a new revision. A status field in the document would therefore change the bytes of a revision that did not move, and one plan revision must have exactly one byte representation. A human reads state through `kanthord status`, `node.list` and `node.show`.

## Canonical layout and byte identity

The daemon stores no path, so export derives one. `slug(title)` lowercases the title, keeps `a-z` and `0-9`, replaces each run of other characters with one `-`, trims a leading and a trailing `-`, truncates to 48 characters, and becomes `node` when the result is empty. Every segment then carries the full 26-character lowercase ULID, always, so that adding a sibling never renames an existing file.

A task ordinal comes from a Kahn walk inside the objective that takes the lexicographically smallest identity whenever several tasks are available. Its width is `max(2, the digit count of the sibling task count)`.

Byte identity needs a canonical rendering, and these rules are it:

- Frontmatter key order is `id`, `kind`, `title`, `depends_on`, `worker`, `repo`. An absent field is omitted, never rendered as null.
- Every scalar is double-quoted, with one escaping rule. No anchors, no aliases, no flow collections, no single quotes.
- `depends_on` is a block sequence, sorted lexicographically by identity.
- UTF-8 and LF only. A document ends with exactly one LF.
- Import normalizes a body: CRLF and a lone CR become LF, and the body ends with exactly one LF. Trailing spaces on a line survive, because two of them are a Markdown hard line break. The normalized body is what `instruction_blob` and `acceptance_blob` store, so export reproduces it exactly.
- Documents are ordered by canonical path, compared bytewise.

The baseline of byte identity is the **accepted** document that import returned, never the document a human authored. An authored document may lack identities, reference by path, and use noncanonical YAML, so no renderer can reproduce it.

## The database is the source of truth

The plan markdown is never committed with the source code. It is what a human authors and what export returns, and it lives on the human's own machine. The graph in the database is the single source of truth, so a plan file is a copy, never an authority.

The daemon therefore holds no plan files. `plan import` sends the document in the request body, and the rewritten document comes back in the response. See [transport.md](transport.md).

## Import protocol

Import is one database transaction, because the daemon has no plan files to stage.

1. Parse and validate the document. Collect every finding and write nothing.
2. Build the rewritten tree in memory, with minted identities and resolved references.
3. In one transaction: compare the parent revision, apply the choices of the section below, commit the rows, and write the new plan revision.
4. Return the accepted documents in the response.

The parent revision is compared inside the transaction. A read before the transaction is a race, and one human with two shells is enough to lose it.

A crash before step 3 changes nothing, and the client sends the request again. A crash after step 3 loses the response, and the client cannot tell whether the import committed. Every import therefore carries a client-minted `import_id`, and a retry of that id returns the original revision and the original rewritten document. `plan export` is authoritative in every other case.

## Re-import is a conflict resolution

A human exports, edits for an hour, and re-imports. State moved in that hour, and that is unavoidable. A single illegal edit must not reject the other nineteen, so a re-import carries a decision per node instead of one verdict per document.

The model is a git merge with the merge itself removed. There is no field-level three-way merge and there are no conflict markers. Each node takes one binary choice:

| Choice      | Meaning                                                               |
| ----------- | --------------------------------------------------------------------- |
| `submitted` | the document is right about the import-controlled fields of this node |
| `database`  | the daemon is right, and the edit to this node is discarded           |

The import-controlled fields are `title`, the body, `depends_on`, `worker`, `repo` and the containment parent. State is never one of them, and a choice of `submitted` never writes a state.

**Every node carries a choice, and there is no implicit default.** The required set is the union of the document identities and the database identities at the validated revision. A missing choice and an extra choice are both `400`.

### Topology drift and state drift are separate concerns

An import carries the plan revision it was exported from, and a mismatch is rejected. Another import rewrote the topology, so the base of every suggestion is wrong and the human re-exports. The choice model resolves state drift only. With the revision compared for equality, the stored plan data equals the base by construction, so a three-way classification would degenerate to a two-way one and buy nothing. The merge-base model is in `../after-the-mvp.md`.

### The suggestion, per case

`plan.validate` computes a suggestion for every node, and a client pre-selects it. A structural change touches `depends_on`, `worker`, `repo` or the parent. A prose change touches `title` or the body.

This table is normative. It holds every case, and a case absent from it is a defect rather than a judgment the implementer makes.

| Case                                                                                               | Suggestion  | The other choice                       |
| -------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------- |
| No difference                                                                                      | `database`  | legal, and equivalent                  |
| Node only in the document                                                                          | `submitted` | legal, and it means "do not create it" |
| Node only in the database                                                                          | `database`  | illegal; a deletion is `node.discard`  |
| `pending` or `blocked`, any change                                                                 | `submitted` | legal                                  |
| `ready`, prose only                                                                                | `submitted` | legal                                  |
| `ready`, structural                                                                                | `database`  | illegal                                |
| `running` or `awaiting_approval`, prose only                                                       | `database`  | legal                                  |
| `running` or `awaiting_approval`, structural                                                       | `database`  | illegal                                |
| `done`, `partial` or `discarded`, prose only                                                       | `database`  | legal                                  |
| `done`, `partial` or `discarded`, structural                                                       | `database`  | illegal                                |
| Any state, one node with both a prose and a structural change, where the structural one is illegal | `database`  | illegal                                |

A prose edit on a `discarded` node is legal. Import ignores state, so a new title neither resurrects the node nor clears `discard_reason`.

The last row is the cost of a per-node choice. The node is one unit, so the whole node falls to `database` and the legal prose edit is lost with the illegal structural one. `plan.validate` reports the differing field names per node, so a human sees that cost before choosing, and a re-export then carries the prose edit alone.

### Containment needs more than a state

A `blocked` node can still hold a lease, a workspace or a commit, so state alone does not decide a move.

- A task changes parent only while it is `pending` or `blocked`, and only when it holds no lease, no workspace, no attempt commit and no retained commit.
- An objective changes parent, or changes `repo`, only when that holds for the objective and for every descendant.
- Otherwise the suggestion is `database` and `submitted` is illegal.
- A path that moves without changing the derived parent is cosmetic, and it is not a difference at all.

### A choice is not independent of the other choices

Two legal choices can build a graph that neither side authored. The database holds `B → A`. The document deletes that edge and adds `A → B`, and the document is acyclic. Take `submitted` for `A` and `database` for `B`, and both edges exist. That is a cycle.

The daemon therefore builds the whole candidate graph from every choice, and re-runs the full validation over it — schema, references, containment, cycles, repository, worker and empty parents. It applies nothing unless the whole candidate is valid, and it never repairs a choice by itself.

A suggestion set is held to the same standard, because a client must never pre-select a combination that the import will reject. The daemon computes the local suggestions, finds each connected component whose combination is invalid, and resets that whole component to `database`. It repeats until the graph is valid. The database baseline is always valid, so the procedure terminates.

### A kind change is an addition and a retention

A human deletes `task_X` and writes an objective in its place. The daemon infers no rename: the new identity is an addition, and `task_X` is a database-only node that is retained. `plan.validate` reports both facts together, so a client shows the pair rather than hiding it. One ULID payload under two kind prefixes is `422 identity-kind-mismatch`.

### A suggestion goes stale, and the transaction is what catches it

State can move between `plan.validate` and `plan.import`. A node acquires a commit while it stays `running`, and a state can leave and return, so the observed state is not a concurrency token.

- `plan.validate` returns the hash of the submitted documents and the topology revision it validated against. The submission binds to both.
- Topology moved since then, so the required choice set changed: `409 choices-stale`, with a fresh conflict set.
- State moved, but topology held: the transaction recomputes the legality of every selected outcome against the current leases, workspaces, commits, descendants and edge rows. A state change alone is not a rejection. `running` becoming `awaiting_approval` invalidates nothing when the choice was `database`.
- Every selected outcome still legal, and the candidate graph valid: commit.
- Otherwise `409 choices-changed`, and nothing is written. A half-applied plan is a graph no human authored.

### The remaining rules

- A node absent from the import set is not deleted. It is reported, and the human discards it explicitly through `../api/outcome.md`.
- A duplicate identity fails the import.
