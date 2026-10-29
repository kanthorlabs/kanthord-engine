# Execution plans

Each ERD page of `docs/reference/erd/` has one plan set in its own directory. The directory name repeats the ERD page name. Each set holds its own `00-index.md`, its own `decisions.md` and its numbered plans. Plan numbers restart at `01` in every set. A later set builds on every earlier set.

| ERD                          | Source page                            | Plan set                                                | Status                        |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------- | ----------------------------- |
| 1 — Environment and planning | `docs/reference/erd/01-setup.md`       | [`erd-01-setup/`](erd-01-setup/00-index.md)             | Planned; blockers B1–B5 fixed |
| 2 — Execution                | `docs/reference/erd/02-execution.md`   | [`erd-02-execution/`](erd-02-execution/00-index.md)     | Planned                       |
| 3 — External integration     | `docs/reference/erd/03-integration.md` | [`erd-03-integration/`](erd-03-integration/00-index.md) | Planned; blockers B1–B11 open |
| 4 — Telemetry                | `docs/reference/erd/04-tracking.md`    | `erd-04-tracking/`                                      | Not planned                   |

Two plan sets follow no ERD page. [`flat-nodes/`](flat-nodes/00-index.md) implements the flat-node model and the rulings R1 to R14 of the root design pages of pull request #87 in the plans 01 to 10, with the plans 03b, 09a and 09b. Its status is Planned. [`dogfood-fixes/`](dogfood-fixes/00-index.md) fixes the defects K3 to K7 of the worker-routing dogfood run of 2026-10-29 in the plans 01 to 05. K2 needs no plan under the ruling of decision D5. Its status is Planned.

Cite a plan by its set and file, for example `erd-01-setup/05-project-service.md` task 05.9, because every set reuses the plan numbers.
