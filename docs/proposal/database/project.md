# project

**Question it answers:** which worker kind and which end-to-end binding does work under this project inherit?

```sql
CREATE TABLE project (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  worker     TEXT,             -- default worker kind for every node here; node.worker overrides it
  e2e_json   TEXT,             -- deferred initiative end-to-end binding: harness command and manifest rule
  updated_at INTEGER NOT NULL  -- last edit of a default
) STRICT;
```

`worker` is the project-level worker binding. Precedence is project, then graph, then node, and the most specific binding wins. The graph level and the node level are both `node.worker`, because an initiative is a node. So three levels of precedence need two columns and no extra table.

`e2e_json` is the deferred project-level end-to-end binding of [../phase-2/gates-and-approval.md](../phase-2/gates-and-approval.md). It names a harness command and the repository-to-commit manifest rule. A null value means an initiative of this project records `not-applicable`, which is every MVP initiative.

## Example

```
id        project_01JQ8Z5C9D
name      kanthord-verify
worker    general@1
e2e_json  (null)
```

`kanthord project create --name kanthord-verify` inserts this row. `worker` makes `general@1` the default for every node of the project, and a node that names its own worker overrides it.

`e2e_json` is null, so every initiative of this project records its end-to-end check as `not-applicable`. That is the MVP case, and it appears in the evidence rather than being reported as a pass.
