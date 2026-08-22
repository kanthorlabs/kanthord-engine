import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { eventListRequest } from "../../contract/event.ts";
import { singleValued } from "../single.ts";
import type {
  EventView,
  ListEventInput,
} from "../../../queries/event/list-event.ts";

export type ListEventHandlerDependencies = Readonly<{
  listEvents: (input: ListEventInput) => readonly EventView[];
}>;

export function listEventHandler(
  dependencies: ListEventHandlerDependencies,
): Handler {
  return (context) => {
    const parsed = eventListRequest.safeParse(singleValued(context.query));
    if (!parsed.success) {
      throw invalidRequest(
        "query-schema",
        "the event filters are not valid",
        parsed.error,
      );
    }
    const events = dependencies.listEvents(parsed.data).map((event) => ({
      id: event.id,
      type: event.type,
      subjectKind: event.subjectKind,
      subjectId: event.subjectId,
      actorKind: event.actorKind,
      actorId: event.actorId,
      payload: event.payload,
      createdAt: event.occurredAt,
    }));
    return { status: 200, body: { events } };
  };
}
