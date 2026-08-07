import { z } from "zod";

import { findingCodes } from "../../domain/plan-finding.ts";

export const planFinding = z.strictObject({
  code: z.enum(findingCodes),
  path: z.string().nullable(),
  id: z.string().nullable(),
  message: z.string(),
});
