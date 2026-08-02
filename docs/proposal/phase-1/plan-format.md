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

Frontmatter fields: `id`, `kind`, `title`, `depends_on`, `worker`. An objective also carries `repo`. Export adds `status`. The body needs an `## Acceptance criteria` heading, because `re@1` judges against it. Everything before that heading is the instruction.

Import validates: schema, cycles, unresolved references, unknown worker kinds, unknown repositories, duplicate identities, a `repo` on a task, a missing `repo` on an objective, and empty parents.

## Identity

Node identity is a ULID in frontmatter. The file path is cosmetic, so a rename does not destroy a node.

`depends_on` accepts a relative file path before identities exist. Import resolves it, mints the ULIDs, writes them into the files and rewrites `depends_on` to ULIDs. Resolution order is ULID first, then path. An unresolved or ambiguous reference fails the import.

Export writes status. Import ignores status. The daemon owns state, so a stale file can never resurrect or discard a node.

## Import protocol

Import crosses the filesystem and the database, so it stages the work.

1. Parse and validate every file. Stop on the first error and write nothing.
2. Build the rewritten tree in memory, with minted identities and resolved references.
3. Write the rewritten files to a temporary directory.
4. Commit the database rows, with the new graph revision.
5. Rename the temporary files into place.

A crash before step 4 leaves the source files untouched. A crash between step 4 and step 5 leaves the database ahead, and the next import detects it by the graph revision and finishes the rename.

## Re-import reconciliation

- An import carries the graph revision it was exported from. A mismatch is rejected, so an old plan cannot overwrite newer topology.
- A node absent from the import set is not deleted. It is reported, and the human discards it explicitly.
- `title` and body may change at any time.
- `depends_on`, `worker` and `repo` may change only while the node is `pending` or `blocked`.
- A duplicate identity fails the import.
