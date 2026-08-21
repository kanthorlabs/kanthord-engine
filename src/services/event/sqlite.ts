import { identityTime } from "../../domain/identity.ts";
import type { IdGenerator } from "../ids/index.ts";
import type { Storage, Transaction } from "../storage/index.ts";
import type {
  AppendEventInput,
  EventFilter,
  EventLog,
  RecordedEvent,
} from "./index.ts";

export type SqliteEventLogDependencies = Readonly<{
  storage: Storage;
  ids: IdGenerator;
}>;

type EventRow = Readonly<{
  id: string;
  subject_kind: string;
  subject_id: string;
  type: string;
  actor_kind: "human" | "daemon";
  actor_id: string;
  payload_json: string;
}>;

export class SqliteEventLog implements EventLog {
  private readonly storage: Storage;
  private readonly ids: IdGenerator;

  constructor(dependencies: SqliteEventLogDependencies) {
    this.storage = dependencies.storage;
    this.ids = dependencies.ids;
  }

  append(transaction: Transaction, input: AppendEventInput): RecordedEvent {
    const id = this.ids.mint("event");
    transaction.run(
      "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        input.subjectKind,
        input.subjectId,
        input.type,
        input.actorKind,
        input.actorId,
        JSON.stringify(input.payload),
      ],
    );
    return {
      id,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      type: input.type,
      actorKind: input.actorKind,
      actorId: input.actorId,
      payload: input.payload,
      occurredAt: identityTime(id) ?? 0,
    };
  }

  list(
    filter: EventFilter,
    transaction?: Transaction,
  ): readonly RecordedEvent[] {
    const read = (open: Transaction): readonly RecordedEvent[] => {
      const clauses: string[] = [];
      const parameters: unknown[] = [];
      if (filter.subjectKind !== undefined) {
        clauses.push("subject_kind = ?");
        parameters.push(filter.subjectKind);
      }
      if (filter.subject !== undefined) {
        clauses.push("subject_id = ?");
        parameters.push(filter.subject);
      }
      if (filter.type !== undefined) {
        clauses.push("type = ?");
        parameters.push(filter.type);
      }
      if (filter.actorKind !== undefined) {
        clauses.push("actor_kind = ?");
        parameters.push(filter.actorKind);
      }
      if (filter.actor !== undefined) {
        clauses.push("actor_id = ?");
        parameters.push(filter.actor);
      }
      if (filter.after !== undefined) {
        clauses.push("id > ?");
        parameters.push(filter.after);
      }
      if (filter.before !== undefined) {
        clauses.push("id < ?");
        parameters.push(filter.before);
      }
      const where =
        clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
      let sql =
        "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event" +
        where +
        (filter.order === "desc" ? " ORDER BY id DESC" : " ORDER BY id ASC");
      if (filter.limit !== undefined) {
        sql += " LIMIT ?";
        parameters.push(filter.limit);
      }
      const rows = open.all(sql, parameters);
      return rows.map((row) => {
        const record = row as EventRow;
        return {
          id: record.id,
          subjectKind: record.subject_kind,
          subjectId: record.subject_id,
          type: record.type,
          actorKind: record.actor_kind,
          actorId: record.actor_id,
          payload: JSON.parse(record.payload_json),
          occurredAt: identityTime(record.id) ?? 0,
        };
      });
    };
    return transaction === undefined
      ? this.storage.transact(read)
      : read(transaction);
  }
}
