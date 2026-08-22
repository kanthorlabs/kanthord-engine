import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { eventListRequest } from "../../contract/event.ts";
import { singleValued } from "../single.ts";
import type {
  EventView,
  ListEventInput,
} from "../../../queries/event/list-event.ts";
import type { WaitRegistry } from "./wait.ts";

export type ListEventHandlerDependencies = Readonly<{
  listEvents: (input: ListEventInput) => readonly EventView[];
  waits: WaitRegistry;
  maxWaitSeconds: number;
}>;

export function listEventHandler(
  dependencies: ListEventHandlerDependencies,
): Handler {
  return async (context) => {
    const parsed = eventListRequest.safeParse(singleValued(context.query));
    if (!parsed.success) {
      throw httpError("invalid-request", "the event filters are not valid");
    }
    const { wait, ...filters } = parsed.data;
    if (wait !== undefined && wait > dependencies.maxWaitSeconds) {
      throw httpError("invalid-request", "the event filters are not valid");
    }
    const formatEvents = (events: readonly EventView[]) =>
      events.map((event) => ({
        id: event.id,
        type: event.type,
        subjectKind: event.subjectKind,
        subjectId: event.subjectId,
        actorKind: event.actorKind,
        actorId: event.actorId,
        payload: event.payload,
        createdAt: event.occurredAt,
      }));
    const waited = await dependencies.waits.wait({
      read: () => dependencies.listEvents(filters),
      waitSeconds: wait ?? 0,
    });
    return { status: 200, body: { events: formatEvents(waited) } };
  };
}
