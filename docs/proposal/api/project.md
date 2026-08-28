# Project

Reviewer: architect. Conventions are [README.md](README.md). The decisions are `../phase-1/domain.md` and `../phase-2/instructions-and-profiles.md`.

A project binds repositories, and it is the scope a plan imports into.

## Routes

| operationId                | Method and path                        | introducedIn | status   | Source                                     |
| -------------------------- | -------------------------------------- | ------------ | -------- | ------------------------------------------ |
| `project.create`           | `POST /v1/project`                     | phase-1      | routed   | phase-2 onboarding CLI, "create a project" |
| `project.list`             | `GET /v1/project`                      | phase-1      | routed   | domain.md                                  |
| `project.show`             | `GET /v1/project/:id`                  | phase-1      | routed   | domain.md                                  |
| `project.repositories`     | `PUT /v1/project/:id/repository`       | phase-1      | routed   | domain.md, "binds repositories"            |
| `project.status`           | `GET /v1/project/:id/status`           | phase-1      | routed   | P1-E1, `kanthord status --project`         |
| `binding.worker.project`   | `PUT /v1/project/:id/binding/worker`   | phase-2      | stubbed  | instructions-and-profiles.md, precedence   |
| `binding.provider.project` | `PUT /v1/project/:id/binding/provider` | post-mvp     | deferred | providers-and-credentials.md, deferred     |
| `binding.e2e.project`      | `PUT /v1/project/:id/binding/e2e`      | post-mvp     | deferred | gates-and-approval.md, deferred            |

## `project.status`

The route reports the graph one project holds: the objective count and the task count. It is the project-scoped counterpart of `system.md` `system.status`, which reports the daemon rather than one project, and it is what `kanthord status --project <id>` reads.

A count is of nodes bound to the project, so a second project never changes the first one's answer.

## `project.repositories`

The body is the full list of repository ids. `PUT` replaces it, because a binding set is a value and a partial edit of it has no meaning here.

The route writes `project_binding` rows of `kind = 'git'`. It stays a domain-specific operation rather than a generic `bindings/:kind` route: a repository set is replaceable, a provider binding is an ordered chain, and one route spelling would hide that difference behind the storage dispatch key.

A repository registers globally and a project binds it, so two projects can share one repository and neither owns it. Import rejects an objective that names a repository this project does not bind.

The MVP binds one repository per project. Multi-repository projects are deferred, so the daemon refuses a list longer than one entry. The route already carries the list, because the entity model does.

The CLI resolves repository names from `repository.list`. An unknown exact name prints all known names deduplicated and bytewise-sorted before it writes nothing.

## `binding.worker.project`

Worker binding precedence is project, then graph, then node. The most specific binding wins. This route sets the project level, which `../database/project.md` stores as the `worker` column. A binding operation may persist to a column; three levels of precedence need two columns and no extra table.

The graph level and the node level are both `node.worker`, and they arrive through the plan document in the `worker` frontmatter field. Neither has a route of its own — only a human mutates the graph, and a human does that by importing a plan.

`run.worker` records what actually resolved at execution time, so editing this binding never rewrites history.

## Deferred rows

`binding.provider.project` and `binding.e2e.project` have no route. A request to either path returns `404`. They appear here because the entity model holds their shape and a reviewer must see where they will attach.
