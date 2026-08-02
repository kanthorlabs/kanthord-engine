# project_binding

**Question it answers:** which globally registered resources does this project use?

```sql
CREATE TABLE project_binding (
  project_id TEXT NOT NULL REFERENCES project(id),                -- project that uses the resource
  kind       TEXT NOT NULL CHECK (kind IN ('git', 'provider')),  -- resource type; the MVP writes 'git' only
  target_id  TEXT NOT NULL,                                       -- the bound resource, prefixed: a repo_ or provider_ id
  created_at INTEGER NOT NULL,                                    -- when the binding was made; a composite key carries no time
  PRIMARY KEY (project_id, kind, target_id)
) STRICT;
```

A project binds a resource that registers at global scope. `kind` names the resource type, and `target_id` holds the id of that resource.

`kind = 'git'` binds a git repository, and `target_id` is a `repository.id`. That is the only kind the MVP writes.

`kind = 'provider'` binds a provider registration, and `target_id` is a `provider.id`. It replaces the project scope of the `provider_binding` table that no longer exists. A project with no such row inherits the global chain, which is the `set_default_at` column of [provider.md](provider.md). Several rows form the project chain, ordered by `created_at`. Nothing writes this kind in the MVP, because the ordered list is deferred.

A later kind adds a value to the `CHECK` clause and no table, so the shape does not have to be guessed now.

A repository registers globally, and a project binds it. Multi-repository projects are deferred, and this table holds the shape without a column on `repository` that would forbid two projects from sharing one repository.

The key is composite and holds no time, so `created_at` records when the binding was made.

`target_id` is polymorphic, so it carries no foreign key. The command validates the target against the table that `kind` names, and the id prefix makes a wrong value visible without a join.

Agent-level binding gets its own `agent_binding` table when it is built, and not a scope value here, because an agent kind is not a row of any table and a project id is. Neither table carries a model override yet, so the `defaultModel` of the provider payload applies. See [../after-the-mvp.md](../after-the-mvp.md).

Import validates that the repository named by an objective is bound to the project of that objective, through a row of `kind = 'git'`.

## Example

```
project_id          kind  target_id
project_01JQ8Z5C9D  git   repo_01JQ8Z4A2B
```

The human registers the repository globally, then binds it to the project. Import reads this row to reject an objective that names a repository the project does not use.

`kind = 'git'` is the only value the MVP writes. A project that later needs its own provider chain adds `('project_01JQ8Z5C9D', 'provider', 'provider_01JQ8Z3K7M')` here, and `target_id` still says what it points at because the id carries its prefix.
