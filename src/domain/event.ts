import { z } from "zod";

import { identity, anyIdentity } from "./identity.ts";
import { jsonText } from "./column.ts";

export const eventRow = z.object({
  id: identity("event"),
  subjectKind: z.string(),
  subjectId: anyIdentity,
  type: z.string(),
  actorKind: z.enum(["human", "daemon"]),
  actorId: z.string(),
  payloadJson: jsonText,
});
export type EventRow = z.infer<typeof eventRow>;
