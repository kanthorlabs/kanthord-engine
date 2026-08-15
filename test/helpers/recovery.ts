import type { Clock } from "../../src/services/clock/index.ts";
import type {
  EventLog,
  RecordedEvent,
} from "../../src/services/event/index.ts";
import { SqliteEventLog } from "../../src/services/event/sqlite.ts";
import type { GitJournal } from "../../src/services/git/index.ts";
import { createGitJournal } from "../../src/services/git/journal.ts";
import type { Storage } from "../../src/services/storage/index.ts";
import { createMigratedStorage } from "./database.ts";
import { createMockClock } from "./clock.ts";
import { createMockIdGenerator } from "./ids.ts";

const PROVIDER_ID = "provider_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const EVENT_ULIDS: readonly string[] = Array.from(
  { length: 128 },
  (_, index) => {
    let value = index;
    let ulid = "";
    for (let position = 0; position < 26; position++) {
      ulid = ULID_ALPHABET[value % 32]! + ulid;
      value = Math.floor(value / 32);
    }
    return ulid;
  },
);

export type RecoveryFixture = Readonly<{
  storage: Storage;
  journal: GitJournal;
  events: EventLog;
  clock: Clock;
  seedRepository(
    input: Readonly<{ id: string; name: string; homePath: string }>,
  ): void;
  seedWorkspace(
    input: Readonly<{ id: string; repositoryId: string; path: string }>,
  ): void;
  seedGitOperation(row: Readonly<Record<string, unknown>>): void;
  readGitOperation(id: string): Readonly<Record<string, unknown>>;
  listEvents(): readonly RecordedEvent[];
  dispose(): void;
}>;

export function createRecoveryFixture(): RecoveryFixture {
  const temporary = createMigratedStorage();
  const storage = temporary.storage;
  const journal = createGitJournal();
  const events: EventLog = new SqliteEventLog({
    storage,
    ids: createMockIdGenerator({ ulids: EVENT_ULIDS }),
  });
  const clock = createMockClock({ start: 1700000000000 });
  storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        PROVIDER_ID,
        "fixture",
        "git",
        null,
        new Uint8Array([1]),
        new Uint8Array(12),
        new Uint8Array(16),
        1,
        1700000000000,
      ],
    );
  });
  return {
    storage,
    journal,
    events,
    clock,
    seedRepository(input) {
      storage.transact((transaction) => {
        transaction.run(
          "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            input.id,
            input.name,
            "ssh://git@forge.test/owner/repo.git",
            PROVIDER_ID,
            input.homePath,
            "main",
            "kanthord/landing",
            "refs/heads/kanthord/publish",
            0,
            "ready",
            null,
            null,
            null,
            1700000000000,
          ],
        );
      });
    },
    seedWorkspace(input) {
      storage.transact((transaction) => {
        const blob = `sha256:${"0".repeat(64)}`;
        const projectId = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
        const revisionId = "revision_01ARZ3NDEKTSV4RRFFQ69G5FAV";
        const nodeId = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
        transaction.run(
          "INSERT INTO blob (hash, size, content, created_at) VALUES (?, ?, ?, ?)",
          [blob, 1, new Uint8Array([0]), 1700000000000],
        );
        transaction.run(
          "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
          [projectId, "fixture-project", null, null, 1700000000000],
        );
        transaction.run(
          "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)",
          [revisionId, projectId, null, "imp_fixture", blob, blob, blob],
        );
        transaction.run(
          "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            nodeId,
            projectId,
            "initiative",
            null,
            "fixture",
            blob,
            null,
            null,
            null,
            "pending",
            null,
            null,
            revisionId,
            1700000000000,
          ],
        );
        transaction.run(
          "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            input.id,
            nodeId,
            input.repositoryId,
            input.path,
            "a".repeat(40),
            "a".repeat(40),
            blob,
            "coding/v1",
            null,
            "ready",
            1700000000000,
          ],
        );
      });
    },
    seedGitOperation(row) {
      storage.transact((transaction) => {
        transaction.run(
          "INSERT INTO git_operation (id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, child_token, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            row.id,
            row.repository_id,
            row.intent,
            row.node_id,
            row.run_id,
            row.candidate_id,
            row.lease_fence,
            row.ref,
            row.base_oid,
            row.proposed_head_oid,
            row.result_head_oid,
            row.expected_remote_oid,
            row.state,
            row.outcome,
            row.detail_blob,
            row.child_token,
            row.completed_at,
          ],
        );
      });
    },
    readGitOperation(id) {
      return storage.transact((transaction) =>
        transaction.get("SELECT * FROM git_operation WHERE id = ?", [id]),
      ) as Readonly<Record<string, unknown>>;
    },
    listEvents() {
      return events.list({});
    },
    dispose() {
      temporary.dispose();
    },
  };
}
