import { z } from "zod";

import { identity, nodeIdentity } from "./identity.ts";
import { epochMillis } from "./column.ts";

export const edgeRow = z
  .object({
    id: identity("edge"),
    fromNode: nodeIdentity,
    toNode: nodeIdentity,
    waivedAt: epochMillis.nullable(),
  })
  .refine((row) => row.fromNode !== row.toNode, {
    message: "from_node <> to_node",
  });
export type EdgeRow = z.infer<typeof edgeRow>;
