import { z } from "zod";

import { identity, anyIdentity } from "./identity.ts";
import { jsonText } from "./column.ts";

export const eventActorKinds = ["human", "daemon", "harness"] as const;
export type EventActorKind = (typeof eventActorKinds)[number];

export const eventRow = z.object({
  id: identity("event"),
  subjectKind: z.string(),
  subjectId: anyIdentity,
  type: z.string(),
  actorKind: z.enum(eventActorKinds),
  actorId: z.string(),
  payloadJson: jsonText,
});
export type EventRow = z.infer<typeof eventRow>;
