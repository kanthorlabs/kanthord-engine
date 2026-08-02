# Git foundation

Reviewer: git or release engineer. Phase 1. This file defines where code lives. How it moves is `../phase-2/integration-and-publish.md`.

## Three repositories, three roles

- **Remote origin** is the shared repository. Many people work on it through the standard git workflow. It is the source of truth for the team.
- **The bare home** is local to the daemon machine, one per repository, created once. It is the only clone with an `origin`, so it alone fetches from and pushes to remote origin. It is the integration point for agent work.
- **An objective clone** is created per objective from the bare home. It has no configured remote and knows only the bare home.

```
.data/repos/<repo>.git                 bare home, never checked out
.data/workspaces/<objective-id>/       clone, shared by the tasks of that objective
```

## Three ref roles, never blurred

| Role                | Ref                       | Written by                                 | Never written by |
| ------------------- | ------------------------- | ------------------------------------------ | ---------------- |
| Remote observation  | `refs/remotes/origin/*`   | `fetch`, which may force-update            | anything else    |
| Local landing       | `refs/heads/<landing>`    | `mr@1`, reconcile, and a safe fast-forward | `fetch`          |
| Publish destination | the remote `<publishRef>` | `publish`, against an expected object id   | —                |

A remote branch can be force-pushed, so the force flag belongs on remote-tracking refs. It must never reach `refs/heads/*`, where unpublished integrated work lives.

## Seeding the bare home

`git clone --bare` is forbidden here. A bare clone copies remote heads directly into `refs/heads/*`, and a bare repository has no checked-out branch to protect them, so a later fetch or a remote force-push can destroy local integrated work. Seeding is explicit:

```
git init --bare .data/repos/<name>.git
git -C <home> remote add origin <url>
git -C <home> config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git -C <home> fetch --prune origin
git -C <home> update-ref refs/heads/<landing> refs/remotes/origin/<upstream>
```

`kanthord repository register --url <remote>` runs this. It detects the default branch from the remote `HEAD`, prints it, and asks the human to confirm. Detection never applies by itself, because a wrong default sends every later merge to the wrong branch and nothing can notice.

Git authentication to the remote is ambient on the daemon machine, through an SSH agent or a git credential helper. KanthorD stores no git credential. This is separate from the provider credentials of `../phase-2/providers-and-credentials.md`.

## Three branch fields

A repository declares three, because one field cannot express the branch mode.

| Field            | Meaning                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `upstreamBranch` | the freshness source, observed at `refs/remotes/origin/<upstreamBranch>`                       |
| `landingBranch`  | `refs/heads/<landingBranch>`, where `mr@1` accumulates approved work and objectives clone from |
| `publishRef`     | the destination ref on remote origin                                                           |

| Mode                               | `upstreamBranch` | `landingBranch`   | `publishRef`                 |
| ---------------------------------- | ---------------- | ----------------- | ---------------------------- |
| Merge into `main`, push `main`     | `main`           | `main`            | `refs/heads/main`            |
| Land on a branch, push that branch | `main`           | `kanthord/<name>` | `refs/heads/kanthord/<name>` |

The branch mode needs the split. `origin/kanthord/<name>` does not exist before the first publish, and objectives still need the latest `origin/main`.

Changing `landingBranch` is an explicit operation, not a configuration edit. It names the object id the new branch starts at, and it states what happens to work already landed on the old branch.

## Clone granularity is the objective

All tasks of one objective share one clone. Tasks in one objective run in sequence, because they share a working tree. One lease covers the whole objective. Concurrency exists between objectives only, and it is deferred past the MVP.

`git clone` configures an `origin` pointing at the source. The daemon therefore clones with `--no-hardlinks`, removes the remote, and asserts that `git remote` returns nothing. The removal is an explicit step, not a property of cloning.

## An objective binds exactly one repository

The binding lives on the objective, not the task. Import rejects a task that names a repository. Node-level worker binding stays legal, because the objective runner dispatches each task in sequence inside the one leased workspace.

## Notes for the implementer

- A clone carries no configured remote, so every ref transfer names an explicit path argument.
- Each commit is attributed to a run and an attempt, which is what makes the recovery rules of `../phase-3/recovery.md` decidable.
- The workspace records a base object id per task. `abandon task` depends on it.
