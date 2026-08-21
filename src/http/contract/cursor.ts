import { z } from "zod";

import { cursorOrders } from "../../domain/cursor.ts";

export const cursorRequest = z.strictObject({
  after: z.string().min(1).optional(),
  before: z.string().min(1).optional(),
  order: z.enum(cursorOrders).default("asc"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const cursorRequestExample: Readonly<{ limit: number }> = {
  limit: 100,
};
