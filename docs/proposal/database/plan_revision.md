# plan_revision

**Question it answers:** which import produced the graph as it stands now, and did the document in my hand come from that same import?

```sql
CREATE TABLE plan_revision (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id),  -- project whose graph this write produced
  parent_id      TEXT REFERENCES plan_revision(id),     -- the parent revision, read inside the transaction
  origin         TEXT NOT NULL CHECK (origin IN ('import', 'node-write')),  -- which write minted this revision
  import_id      TEXT,                                  -- client-minted idempotency key, an import only
  submitted_blob TEXT REFERENCES blob(hash),            -- the document the human sent, an import only
  choices_blob   TEXT REFERENCES blob(hash),            -- the per-node choice set, an import only
  accepted_blob  TEXT NOT NULL REFERENCES blob(hash),   -- the whole resulting graph, canonically rendered
  UNIQUE (project_id, import_id),
  CHECK ((origin = 'import') = (import_id IS NOT NULL)),
  CHECK ((origin = 'import') = (submitted_blob IS NOT NULL)),
  CHECK ((origin = 'import') = (choices_blob IS NOT NULL))
) STRICT;
```

The database is the source of truth for the graph. The plan markdown is an authoring and export format on the human's own machine, and it is never committed with the source code. So this table is not a mirror of any file. It records which import produced the graph, and it holds the two documents of that import.

`parent_id` is the revision the import was exported from. An import carries that value, and a mismatch against the newest revision of the project is rejected, so an old document cannot overwrite newer topology. The newest revision is the greatest `id`, because a ULID sorts by creation time. The comparison runs inside the write transaction. A read of the current revision before the transaction is a race, and one human with two shells is enough to lose it.

`import_id` is minted by the client and it makes an import idempotent. The daemon has no filesystem in common with the human, so the rewritten document travels in the response, and a lost response leaves the client unable to tell whether the import committed. A retry of the same `import_id` returns the original revision and the original `accepted_blob` rather than rejecting on the parent revision. Without it, a stale-revision rejection cannot distinguish "my own request already committed" from "another request committed first".

The three documents are separate columns, because they answer different questions and one column cannot hold them all.

- `submitted_blob` is what the human sent, with path references and missing identities, normalized and sorted by path. It is the record of what a human authored.
- `choices_blob` is the complete per-node choice set of `../phase-1/plan-format.md`. Without it the revision cannot explain itself: the same submission and the same base produce different graphs under different choices.
- `accepted_blob` is the whole resulting graph, canonically rendered. It is not the submission with identities rewritten, because the result holds database-only nodes that were never submitted and omits document-only nodes that took `database`. That is what the import returns, and what a retry returns again.

Export renders from the rows rather than from `accepted_blob`. The two agree at the revision the import wrote, and the rows are the source of truth for every later read. Export chooses the canonical directory layout, since a path is cosmetic and no path is stored. A client replaces its local copy with what export returns.

There is no staged directory, no rename and no `renamed_at`. The daemon holds no plan files, so the import is one transaction: parse, validate, mint, resolve, commit, respond. A crash before the commit changes nothing, and the client re-sends with the same `import_id`. A crash after the commit is the lost-response case above.

This table never merges with `git_operation`. This one is a single database transaction, the other spans a git write that no transaction covers.

## Example

```
id                   parent_id            import_id     submitted_blob  choices_blob    accepted_blob
revision_01JQ8Z7G3H  (null)               imp_a41f0c92  sha256:2f66...  sha256:0d41...  sha256:8ab3...
revision_01JQ8ZR9S1  revision_01JQ8Z7G3H  imp_d70b3e15  sha256:5c19...  sha256:b7cc...  sha256:7e02...
```

The first row is the first import. The human sent a document with `depends_on` written as a file path and no identities, which is `submitted_blob`. The import minted the identities and returned the rewritten document, which is `accepted_blob`.

The second row is a re-import after the human edited a task body on the train. The request carried `parent_id = revision_01JQ8Z7G3H` and one choice per node, and `choices_blob` records what the human decided for each. Had another shell imported in the meantime, the newest revision would differ and the import would be rejected by name.

`import_id` covers the lost response. The daemon commits, the network drops the reply, and the client cannot tell whether the import landed. A retry of `imp_d70b3e15` returns this same revision and the same `accepted_blob` instead of writing a second revision.
