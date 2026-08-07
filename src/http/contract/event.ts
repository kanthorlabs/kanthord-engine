import { z } from "zod";

import { actorKinds } from "../../domain/event.ts";
import { resource } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import { EXAMPLE_AT as A, EXAMPLE_ULID as U } from "./example-literal.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";
import { cursorRequest, cursorRequestExample } from "./cursor.ts";

export const eventListRequest = cursorRequest.extend({
  subjectKind: z.string().min(1).nullable().default(null),
  subject: z.string().min(1).nullable().default(null),
  type: z.string().min(1).nullable().default(null),
  actorKind: z.enum(actorKinds).nullable().default(null),
  actor: z.string().min(1).nullable().default(null),
});

export const eventView = z.strictObject({
  id: z.string(),
  type: z.string(),
  subjectKind: z.string(),
  subjectId: z.string(),
  actorKind: z.enum(actorKinds),
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
    subjectKind: null,
    subject: null,
    type: null,
    actorKind: null,
    actor: null,
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
    query: eventListRequest,
    response: eventListResponse,
    errors: { ...baselineErrors },
    examples: eventListExamples,
  },
]);
