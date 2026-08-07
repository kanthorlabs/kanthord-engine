import type { ActorKind, EventLog } from "../../services/event/index.ts";

export type ListEventDependencies = Readonly<{
  events: EventLog;
}>;

export type ListEventInput = Readonly<{
  subjectKind?: string;
  subject?: string;
  type?: string;
  actorKind?: ActorKind;
  actor?: string;
  after?: string;
  limit: number;
}>;

export type EventView = Readonly<{
  id: string;
  subjectKind: string;
  subjectId: string;
  type: string;
  actorKind: ActorKind;
  actorId: string;
  payload: unknown;
  occurredAt: number;
}>;

export function listEvents(
  dependencies: ListEventDependencies,
  input: ListEventInput,
): readonly EventView[] {
  return dependencies.events.list(input);
}
