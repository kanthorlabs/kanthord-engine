import { z } from "zod";

export const cursorRequest = z.strictObject({
  after: z.string().min(1).nullable().default(null),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const cursorRequestExample: Readonly<{ after: null; limit: number }> = {
  after: null,
  limit: 100,
};
