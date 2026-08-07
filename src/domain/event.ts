import { z } from "zod";

import { identity, anyIdentity } from "./identity.ts";
import { jsonText } from "./column.ts";

export const actorKinds = ["human", "daemon"] as const;
export type ActorKind = (typeof actorKinds)[number];

export const eventRow = z.object({
  id: identity("event"),
  subjectKind: z.string(),
  subjectId: anyIdentity,
  type: z.string(),
  actorKind: z.enum(actorKinds),
  actorId: z.string(),
  payloadJson: jsonText,
});
export type EventRow = z.infer<typeof eventRow>;
