import { z } from "zod";

import { identity } from "./identity.ts";
import { epochMillis, jsonText } from "./column.ts";
import { workerKind } from "./worker.ts";

export const projectRow = z.object({
  id: identity("project"),
  name: z.string(),
  worker: workerKind.nullable(),
  e2eJson: jsonText.nullable(),
  updatedAt: epochMillis,
});
export type ProjectRow = z.infer<typeof projectRow>;
