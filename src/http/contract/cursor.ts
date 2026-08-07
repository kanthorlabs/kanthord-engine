import { z } from "zod";

export const cursorRequest = z.strictObject({
  after: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const cursorRequestExample: Readonly<{ limit: number }> = {
  limit: 100,
};
