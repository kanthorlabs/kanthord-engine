# profile

**Question it answers:** how is this repository verified, and what prose governs an agent that works in it?

```sql
CREATE TABLE profile (
  id            TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL UNIQUE REFERENCES repository(id),  -- repository this profile governs; exactly one profile each
  content_blob  TEXT NOT NULL REFERENCES blob(hash),             -- sha256 of the whole canonical profile document in blob
  updated_at    INTEGER NOT NULL                                 -- last edit; the previous document stays in blob under its own hash
) STRICT;
```

`content_blob` is the sha256 of the whole canonical profile document — the frontmatter and the body together. The blob is immutable, so the content_blob an objective pinned still resolves to the exact `checks`, template metadata and prose that governed that run. An edit writes a new blob and moves the pointer, and `updated_at` records the edit.

The row holds no copy of `template_id`, `checks` or the schema version. Those fields live in the document, and a copy in a column would be a second truth that drifts on the next edit. A reader parses the document. `workspace.profile_blob` is what every result cites.

## Example

```
id             profile_01JQ8Z6E1F
repository_id  repo_01JQ8Z4A2B
content_blob   sha256:9f2a...
```

`kanthord profile instantiate --template nodejs` renders the template into a document, writes it to `blob`, and points this row at it. The document holds the schema version, the template id, version and digest, the `checks` map, and the prose under each role heading.

An edit writes a new blob and moves `content_blob`. The old document stays under its own hash, so `workspace.profile_blob` from last month still resolves to the exact `unit` command that ran then. That is why no `checks` column is copied onto this row.
