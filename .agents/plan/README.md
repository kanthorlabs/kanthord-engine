# Execution plans

Each ERD page of `docs/reference/erd/` has one plan set in its own directory. The directory name repeats the ERD page name. Each set holds its own `00-index.md`, its own `decisions.md` and its numbered plans. Plan numbers restart at `01` in every set. A later set builds on every earlier set.

| ERD                          | Source page                            | Plan set                                                | Status                        |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------- | ----------------------------- |
| 1 — Environment and planning | `docs/reference/erd/01-setup.md`       | [`erd-01-setup/`](erd-01-setup/00-index.md)             | Planned; blockers B1–B5 fixed |
| 2 — Execution                | `docs/reference/erd/02-execution.md`   | [`erd-02-execution/`](erd-02-execution/00-index.md)     | Planned                       |
| 3 — External integration     | `docs/reference/erd/03-integration.md` | [`erd-03-integration/`](erd-03-integration/00-index.md) | Planned; blockers B1–B9 open  |
| 4 — Telemetry                | `docs/reference/erd/04-tracking.md`    | `erd-04-tracking/`                                      | Not planned                   |

Cite a plan by its set and file, for example `erd-01-setup/05-project-service.md` task 05.9, because every set reuses the plan numbers.
