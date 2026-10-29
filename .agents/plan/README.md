# Execution plans

Each ERD page of `docs/reference/erd/` has one plan set in its own directory. The directory name repeats the ERD page name. Each set holds its own `00-index.md`, its own `decisions.md` and its numbered plans. Plan numbers restart at `01` in every set. A later set builds on every earlier set.

| ERD                          | Source page                            | Plan set                                                | Status                        |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------- | ----------------------------- |
| 1 — Environment and planning | `docs/reference/erd/01-setup.md`       | [`erd-01-setup/`](erd-01-setup/00-index.md)             | Planned; blockers B1–B5 fixed |
| 2 — Execution                | `docs/reference/erd/02-execution.md`   | [`erd-02-execution/`](erd-02-execution/00-index.md)     | Planned                       |
| 3 — External integration     | `docs/reference/erd/03-integration.md` | [`erd-03-integration/`](erd-03-integration/00-index.md) | Planned; blockers B1–B11 open |
| 4 — Telemetry                | `docs/reference/erd/04-tracking.md`    | `erd-04-tracking/`                                      | Not planned                   |

Four plan sets follow no ERD page. [`flat-nodes/`](flat-nodes/00-index.md) implements the flat-node model and the rulings R1 to R14 of the root design pages of pull request #87 in the plans 01 to 10, with the plans 03b, 09a and 09b. Its status is Planned. [`dogfood-fixes/`](dogfood-fixes/00-index.md) fixes the defects K3 to K7 of the worker-routing dogfood run of 2026-10-29 in the plans 01 to 05. K2 needs no plan under the ruling of decision D5. Its status is Planned. [`dogfood-time/`](dogfood-time/00-index.md) removes the repeated verification runs of the items T1 to T3 of the time optimization record of the same run in the plans 01 and 02. Plan 03 copies the coder prompt text, and plan 04 writes the usage of a stopped turn for C2. Ulrich ruled O1 to O5, S1 and T5 on 2026-10-29. T5 and C1 need no plan, and the rulings O4 and O5 wait for Ulrich. Its status is Planned. [`suite-pass-record/`](suite-pass-record/00-index.md) builds the other rules of root pull requests #275 and #277 under ruling O4 of `dogfood-time/`: the verification memo, the affected report version 2 with `floor`, the floor attributes, `test_floor_share` and the suite pass record of the engine and the apps repository, in the plans 01 to 08. The suite pass proposal waits for the open items O1 and O2, and plan 05 waits for O3. Its status is Planned.

Cite a plan by its set and file, for example `erd-01-setup/05-project-service.md` task 05.9, because every set reuses the plan numbers.
