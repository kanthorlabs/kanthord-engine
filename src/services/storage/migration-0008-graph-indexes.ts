import type { Migration } from "./migration.ts";

export const migration0008GraphIndexes: Migration = {
  version: 8,
  name: "0008-graph-indexes",
  statements: [
    "CREATE INDEX node_project ON node (project_id, id)",
    "CREATE INDEX edge_from_node ON edge (from_node, to_node)",
  ],
};
