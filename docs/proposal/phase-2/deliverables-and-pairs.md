# Deliverables and node pairs

## Deliverables

A deliverable declares an outcome. It never carries an agent name. The canonical deliverables are `test`, `implementation`, `review` and `expansion`, in that order. `research` is deliberately absent in this phase.

## Legal pairs

The node kind and deliverable form one pair. The complete pair table is:

| Kind         | Deliverable      | Legal | Shape    | State owner              |
| ------------ | ---------------- | ----- | -------- | ------------------------ |
| `initiative` | `test`           | no    | —        | —                        |
| `initiative` | `implementation` | no    | —        | —                        |
| `initiative` | `review`         | no    | —        | —                        |
| `initiative` | `expansion`      | yes   | `parent` | `aggregate`              |
| `objective`  | `test`           | yes   | `atomic` | `attestation-then-human` |
| `objective`  | `implementation` | yes   | `atomic` | `attestation-then-human` |
| `objective`  | `review`         | yes   | `atomic` | `attestation-then-human` |
| `objective`  | `expansion`      | yes   | `parent` | `aggregate`              |
| `task`       | `test`           | yes   | `atomic` | `report`                 |
| `task`       | `implementation` | yes   | `atomic` | `report`                 |
| `task`       | `review`         | yes   | `atomic` | `report`                 |
| `task`       | `expansion`      | no    | —        | —                        |

The table contains eight legal pairs and four illegal pairs. The illegal pairs are `initiative` with `test`, `implementation` or `review`, and `task` with `expansion`.

## Verify block

Every node declares a strict two-key `verify` object. `paths` is a sorted set of absolute paths. `commands` is an ordered sequence of shell strings.

An empty `commands` list asserts nothing. For a parent initiative or objective, this list is the correct final value because no command runs. For an atomic node, this list declares no check and makes the node ineligible for claim. EPIC 049 records this ineligibility in the conversion report. EPIC 050 enforces the claim-time rule. EPIC 047 stores the value and draws no eligibility conclusion.

## Fixed pairs

A pair becomes fixed when its node holds a child or an accepted checkpoint. In EPIC 047, no writer changes a pair in place. `deliverable` belongs to neither `proseFields` nor `structuralFields`. EPIC 052 enforces the rule at the structural patch.

## Null deliverables

A node imported before EPIC 047 has a null `deliverable`. Pair validation does not apply to that node. EPIC 047 does not define its claim eligibility. EPIC 050 owns that rule.

## Legacy worker field

The legacy `node.worker` field remains through EPIC 056. EPIC 057 removes it.

The `worker` field in a plan document is a transitional form. A document carries either `worker` or `deliverable` + `verify`, never both, and EPIC 057 removes `worker` from `planFrontmatter`, `planFrontmatterKeys` and every rendering path. See [phase-1/plan-format.md](../phase-1/plan-format.md) for the two shapes.
