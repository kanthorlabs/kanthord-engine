import { z } from "zod";

import { epochMillis } from "./column.ts";

export const migrationRow = z.object({
  version: z.int(),
  name: z.string(),
  appliedAt: epochMillis,
});
export type MigrationRow = z.infer<typeof migrationRow>;
