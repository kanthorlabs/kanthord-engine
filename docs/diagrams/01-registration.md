# 01 — Registration

What a human registers before any work exists. Owns [`provider`](../proposal/database/provider.md), [`project`](../proposal/database/project.md), [`project_binding`](../proposal/database/project_binding.md), [`repository`](../proposal/database/repository.md) and [`profile`](../proposal/database/profile.md).

Three questions land here. Which external accounts exist? Which project uses which repository? Which repository has which profile?

```mermaid
erDiagram
  provider {
    TEXT id PK
    TEXT name UK
    TEXT kind "llm or git"
    INTEGER set_default_at "non-null joins the chain of its kind"
    BLOB payload_ciphertext "AES-256-GCM"
    INTEGER key_version
    INTEGER updated_at
  }
  project {
    TEXT id PK
    TEXT name UK
    TEXT worker "default worker kind"
    TEXT e2e_json "deferred initiative binding"
    INTEGER updated_at
  }
  project_binding {
    TEXT project_id PK,FK
    TEXT kind PK "git or provider"
    TEXT target_id PK "prefixed; no FK"
    INTEGER created_at
  }
  repository {
    TEXT id PK
    TEXT name UK
    TEXT remote_url "https, or http on loopback"
    TEXT credential_id FK "provider of kind git"
    TEXT home_path "the only clone with an origin"
    TEXT upstream_branch
    TEXT landing_branch
    TEXT publish_ref
    INTEGER publish_on_approval
    TEXT state "ready or needs-reconcile"
    TEXT diverged_landing_oid
    TEXT diverged_upstream_oid
    TEXT fetched_upstream_oid
    INTEGER updated_at
  }
  profile {
    TEXT id PK
    TEXT repository_id FK,UK "exactly one profile each"
    TEXT content_blob FK "the whole canonical document"
    INTEGER updated_at
  }
  blob {
    TEXT hash PK
  }

  provider   ||--o{ repository : "credential_id"
  project    ||--o{ project_binding : "project_id"
  repository ||--o| profile : "repository_id"
  blob       ||--o{ profile : "content_blob"

  project_binding }o..o| repository : "target_id, kind = 'git'"
  project_binding }o..o| provider : "target_id, kind = 'provider'"
```

## What the shape says

**A provider row holds its own secret.** No `credential` table exists. One registration holds one credential, and `payload_ciphertext` holds the credential and the connection fields together. Every read of `provider` names its columns.

**A binding is a composite key, not an id.** `project_binding` mints no id, so it carries `created_at`. `target_id` is polymorphic and has no foreign key. The prefix makes the value self-describing, and application code holds the rule.

**A repository has zero or one profile.** `profile.repository_id` is `NOT NULL UNIQUE`. The schema does not require a profile to exist.

**A profile keeps no derived column.** `content_blob` addresses the whole document. Every reader parses the pinned document, so a check command has one truth.

**The `repository` state clause is a relation rule.** `state = 'needs-reconcile'` holds exactly when both divergence object ids are set. A repository in that state refuses every new objective clone, which stops [03-execution](03-execution.md) at the clone.

## Boundary

`blob` is a reference node. [05-cross-cutting](05-cross-cutting.md) owns it.

`node.repository_id` binds an objective to a repository. [02-plan-graph](02-plan-graph.md) owns that edge. The repository of an objective must be bound to the project of that objective through a `project_binding` row of `kind = 'git'`. No foreign key holds that rule.
