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

## Shape and children

The `Shape` column is a rule, and the graph validator enforces it. A node with the shape `atomic` holds no child. A node with the shape `parent` holds children.

The rule is stated over the parent edge. A child is illegal when its parent has a non-null `deliverable` and the pair of that parent is legal with the shape `atomic`. The finding is `pair-shape-violated`, its scope is structural, and it names the parent. One offending parent gives one finding, whatever the number of its children.

Pair validation does not apply to a null `deliverable`, so a null parent has no shape and this rule does not reach it. `## Null deliverables` states that rule.

Completeness follows the same shape. A parent with the shape `atomic` needs no child, so it gives no `objective-without-task` finding. Every other node keeps the kind rule: an `expansion` initiative needs an objective, and an `expansion` objective needs a task. A null parent keeps the kind rule.

Both the structural patch and `plan import` ask the same question, because the rule describes the graph and not its writer. A stored graph that violates the rule refuses every patch whose staged graph still violates it. A patch that deletes the child repairs it, subject to the node delete rule. No migration repairs a stored violation, and none is necessary: `plan import` is the only writer that can make one, and this rule reaches it.

## Verify block

Every node declares a strict two-key `verify` object. `paths` is a sorted set of absolute paths. `commands` is an ordered sequence of shell strings.

An empty `commands` list asserts nothing. For a parent initiative or objective, this list is the correct final value because no command runs. For an atomic node, this list declares no check and makes the node ineligible for claim. EPIC 049 records this ineligibility in the conversion report. EPIC 050.1 enforces the claim-time rule. EPIC 047 stores the value and draws no eligibility conclusion.

## Fixed pairs

A pair becomes fixed when its node holds a child or an accepted checkpoint. A checkpoint of any kind fixes the pair, and the fix is permanent. A parent objective does not become atomic: an accepted expansion writes a structural checkpoint on the claimed node. A refusal names one reason for each fixed node. `has-accepted-checkpoint` precedes `has-child`, because a checkpoint never goes away and a child sometimes can. A refusal that names the child invites a deletion that cannot legalise the pair. In EPIC 047, no writer changes a pair in place. `deliverable` belongs to neither `proseFields` nor `structuralFields`. EPIC 052 enforces the rule at the structural patch.

## Null deliverables

A node can carry a null `deliverable`. Pair validation does not apply to that node. A claim on it is refused `pair-illegal`. `docs/proposal/phase-2/runs-and-exclusion.md` states the rule.

## Legacy worker field

The legacy `node.worker` field remains through EPIC 056. EPIC 057 removes it.

The `worker` field in a plan document is a transitional form. A document carries either `worker` or `deliverable` + `verify`, never both, and EPIC 057 removes `worker` from `planFrontmatter`, `planFrontmatterKeys` and every rendering path. See [phase-1/plan-format.md](../phase-1/plan-format.md) for the two shapes.
