# Plan format

Reviewer: developer experience. Phase 1. This file describes what a human writes by hand, and what happens when they import it.

## Only a human mutates the graph

Through the HTTP API, or through export, edit and re-import. No agent changes the graph.

## Layout

Markdown with YAML frontmatter. The `yaml` dependency parses it. `zod` validates it.

```
plan/<initiative>/initiative.md
plan/<initiative>/<objective>/objective.md
plan/<initiative>/<objective>/01-<task>.md
```

This layout is the human's own directory, and export writes it. The daemon stores no path.

Frontmatter fields: `id`, `kind`, `title`, `depends_on`, `worker`. An objective also carries `repo`. Export adds `status`. The body needs an `## Acceptance criteria` heading, because `re@1` judges against it. Everything before that heading is the instruction.

Import validates: schema, cycles, unresolved references, unknown worker kinds, unknown repositories, duplicate identities, a `repo` on a task, a missing `repo` on an objective, and empty parents.

## Identity

Node identity is a prefixed ULID in frontmatter, and the prefix is the kind: `initiative_<ulid>`, `objective_<ulid>`, `task_<ulid>`. A `depends_on` entry therefore names the level it points at. See [../database/node.md](../database/node.md). The file path is cosmetic, so a rename does not destroy a node.

`depends_on` accepts a relative file path before identities exist. Import resolves it, mints the identities, and returns a document that carries them with `depends_on` rewritten to identities. The client writes that document over its own copy. Resolution order is ULID first, then path. An unresolved or ambiguous reference fails the import.

Export writes status. Import ignores status. The daemon owns state, so a stale file can never resurrect or discard a node.

## The database is the source of truth

The plan markdown is never committed with the source code. It is what a human authors and what export returns, and it lives on the human's own machine. The graph in the database is the single source of truth, so a plan file is a copy, never an authority.

The daemon therefore holds no plan files. `plan import` sends the document in the request body, and the rewritten document comes back in the response. See [transport.md](transport.md).

## Import protocol

Import is one database transaction, because the daemon has no plan files to stage.

1. Parse and validate the document. Stop on the first error and write nothing.
2. Build the rewritten tree in memory, with minted identities and resolved references.
3. In one transaction: compare the parent revision, commit the rows, and write the new plan revision.
4. Return the rewritten document in the response.

The parent revision is compared inside the transaction. A read before the transaction is a race, and one human with two shells is enough to lose it.

A crash before step 3 changes nothing, and the client sends the request again. A crash after step 3 loses the response, and the client cannot tell whether the import committed. Every import therefore carries a client-minted `import_id`, and a retry of that id returns the original revision and the original rewritten document. `plan export` is authoritative in every other case.

## Re-import reconciliation

- An import carries the plan revision it was exported from. A mismatch is rejected, so an old plan cannot overwrite newer topology.
- A node absent from the import set is not deleted. It is reported, and the human discards it explicitly.
- `title` and body may change at any time.
- `depends_on`, `worker` and `repo` may change only while the node is `pending` or `blocked`.
- A duplicate identity fails the import.
