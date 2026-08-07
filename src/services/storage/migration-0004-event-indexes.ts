import type { Migration } from "./migration.ts";

export const migration0004EventIndexes: Migration = {
  version: 4,
  name: "0004-event-indexes",
  statements: [
    "CREATE INDEX event_subject ON event (subject_kind, subject_id, id)",
    "CREATE INDEX event_type ON event (type, id)",
    "CREATE INDEX event_actor ON event (actor_kind, actor_id, id)",
  ],
};
