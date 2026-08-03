import type { Transaction } from "../storage/index.ts";

export type ActorKind = "human" | "daemon";

export type AppendEventInput = Readonly<{
  subjectKind: string;
  subjectId: string;
  type: string;
  actorKind: ActorKind;
  actorId: string;
  payload: unknown;
}>;

export type RecordedEvent = Readonly<{
  id: string;
  subjectKind: string;
  subjectId: string;
  type: string;
  actorKind: ActorKind;
  actorId: string;
  payload: unknown;
  occurredAt: number;
}>;

export type EventFilter = Readonly<{
  subjectKind?: string;
  subject?: string;
  type?: string;
  actorKind?: ActorKind;
  actor?: string;
  after?: string;
  limit?: number;
}>;

export type EventErrorCode = "event-append-failed";

export class EventError extends Error {
  readonly code: EventErrorCode;
  constructor(code: EventErrorCode, message: string) {
    super(message);
    this.name = "EventError";
    this.code = code;
  }
}

export interface EventLog {
  append(transaction: Transaction, input: AppendEventInput): RecordedEvent;
  list(
    filter: EventFilter,
    transaction?: Transaction,
  ): readonly RecordedEvent[];
}
