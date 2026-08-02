# plan_revision

**Question it answers:** which import produced the graph as it stands now, and did the document in my hand come from that same import?

```sql
CREATE TABLE plan_revision (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id),  -- project whose graph this import wrote
  parent_id      TEXT REFERENCES plan_revision(id),     -- revision the document was exported from; the concurrency check reads it
  import_id      TEXT NOT NULL,                         -- client-minted idempotency key; a retry returns this same revision
  submitted_blob TEXT NOT NULL REFERENCES blob(hash),   -- document the human sent, with paths and missing identities
  accepted_blob  TEXT NOT NULL REFERENCES blob(hash),   -- rewritten document the import returned, with identities resolved
  UNIQUE (project_id, import_id)
) STRICT;
```

The database is the source of truth for the graph. The plan markdown is an authoring and export format on the human's own machine, and it is never committed with the source code. So this table is not a mirror of any file. It records which import produced the graph, and it holds the two documents of that import.

`parent_id` is the revision the import was exported from. An import carries that value, and a mismatch against the newest revision of the project is rejected, so an old document cannot overwrite newer topology. The newest revision is the greatest `id`, because a ULID sorts by creation time. The comparison runs inside the write transaction. A read of the current revision before the transaction is a race, and one human with two shells is enough to lose it.

`import_id` is minted by the client and it makes an import idempotent. The daemon has no filesystem in common with the human, so the rewritten document travels in the response, and a lost response leaves the client unable to tell whether the import committed. A retry of the same `import_id` returns the original revision and the original `accepted_blob` rather than rejecting on the parent revision. Without it, a stale-revision rejection cannot distinguish "my own request already committed" from "another request committed first".

The two documents are separate columns, because they answer different questions and one column cannot hold both.

- `submitted_blob` is what the human sent, with path references and missing identities. It is the record of what a human authored.
- `accepted_blob` is the rewritten document, with the minted identities and the resolved references. That is what the import returns, and what a retry returns again.

Export renders from the rows rather than from `accepted_blob`, because export adds `status`, and status changes after the import. Export also chooses the canonical directory layout, since a path is cosmetic and no path is stored. A client replaces its local copy with what export returns.

There is no staged directory, no rename and no `renamed_at`. The daemon holds no plan files, so the import is one transaction: parse, validate, mint, resolve, commit, respond. A crash before the commit changes nothing, and the client re-sends with the same `import_id`. A crash after the commit is the lost-response case above.

This table never merges with `git_operation`. This one is a single database transaction, the other spans a git write that no transaction covers.

## Example

```
id                   parent_id            import_id     submitted_blob  accepted_blob
revision_01JQ8Z7G3H  (null)               imp_a41f0c92  sha256:2f66...  sha256:8ab3...
revision_01JQ8ZR9S1  revision_01JQ8Z7G3H  imp_d70b3e15  sha256:5c19...  sha256:7e02...
```

The first row is the first import. The human sent a document with `depends_on` written as a file path and no identities, which is `submitted_blob`. The import minted the identities and returned the rewritten document, which is `accepted_blob`.

The second row is a re-import after the human edited a task body on the train. The request carried `parent_id = revision_01JQ8Z7G3H`. Had another shell imported in the meantime, the newest revision would differ and the import would be rejected by name.

`import_id` covers the lost response. The daemon commits, the network drops the reply, and the client cannot tell whether the import landed. A retry of `imp_d70b3e15` returns this same revision and the same `accepted_blob` instead of writing a second revision.
