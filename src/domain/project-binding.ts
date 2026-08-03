import { z } from "zod";

import { identity, anyIdentity } from "./identity.ts";
import { epochMillis } from "./column.ts";

export const projectBindingRow = z.object({
  projectId: identity("project"),
  kind: z.enum(["git", "provider"]),
  targetId: anyIdentity,
  createdAt: epochMillis,
});
export type ProjectBindingRow = z.infer<typeof projectBindingRow>;
