import { z } from "zod";

import { eventActorKinds } from "../../domain/event.ts";
import { resource } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import { EXAMPLE_AT as A, EXAMPLE_ULID as U } from "./example-literal.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";
import { cursorRequest, cursorRequestExample } from "./cursor.ts";

export const eventListRequest = cursorRequest.extend({
  subjectKind: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  actorKind: z.enum(eventActorKinds).optional(),
  actor: z.string().min(1).optional(),
});

export const eventView = z.strictObject({
  id: z.string(),
  type: z.string(),
  subjectKind: z.string(),
  subjectId: z.string(),
  actorKind: z.enum(eventActorKinds),
  actorId: z.string(),
  payload: z.unknown(),
  createdAt: z.number().int(),
});

export const eventListResponse = z.strictObject({
  events: z.array(eventView),
});

export const eventListExamples: OperationExamples = {
  query: {
    ...cursorRequestExample,
    order: "asc",
    subjectKind: "node",
    subject: `task_${U}`,
    type: "node.state.changed",
    actorKind: "daemon",
    actor: "kanthord",
  },
  success: {
    events: [
      {
        id: `event_${U}`,
        type: "node.state.changed",
        subjectKind: "node",
        subjectId: `task_${U}`,
        actorKind: "daemon",
        actorId: "kanthord",
        payload: { from: "pending", to: "ready" },
        createdAt: A,
      },
    ],
  },
  error: {
    error: { code: "invalid-request", message: "limit must not exceed 500" },
  },
};

export const event = operations([
  {
    operationId: "event.list",
    method: "GET",
    path: [resource("event")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    query: eventListRequest,
    response: eventListResponse,
    errors: { ...baselineErrors },
    examples: eventListExamples,
  },
]);
