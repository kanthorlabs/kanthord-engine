# edge

**Question it answers:** what must finish before this node becomes ready?

```sql
CREATE TABLE edge (
  id        TEXT PRIMARY KEY,
  from_node TEXT NOT NULL REFERENCES node(id),  -- the dependent node
  to_node   TEXT NOT NULL REFERENCES node(id),  -- the node that must reach done or partial first
  waived_at INTEGER,                            -- set when a human waived the edge; readiness then ignores the row
  UNIQUE (from_node, to_node),
  CHECK (from_node <> to_node)
) STRICT;
```

`from_node` depends on `to_node`. Containment is `node.parent_id`, so this table holds dependency only. Import validates that both ends share one parent, because a dependency connects siblings.

`waive` sets `waived_at` and does not delete the row, so the human decision stays readable next to its event. Readiness ignores a row with a `waived_at` value. A re-import that rewires a dependency inserts a new row, and it never clears a waiver, because that would erase a human decision.

## Example

```
id               from_node        to_node          waived_at
edge_01JQ8ZCS3T  task_01JQ8ZBQ1R  task_01JQ8ZAN9P  (null)
```

The human wrote `depends_on: [01-render-json.md]` in the second task file, and import resolved the path to the identity of task 1. Task 2 stays `pending` until task 1 reaches `done` or `partial`.

If the human discards task 1, task 2 moves to `blocked` with reason `dependency-discarded`. `kanthord waive` then sets `waived_at`, readiness ignores the row, and the row survives as the record of that decision.
