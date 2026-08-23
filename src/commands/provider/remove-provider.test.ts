import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AesGcmCrypto } from "../../services/crypto/aes-gcm.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import { RemoveProviderError, removeProvider } from "./remove-provider.ts";
import type { RemoveProviderDependencies } from "./remove-provider.ts";
import { registerProvider } from "./register-provider.ts";
import type { RegisterProviderDependencies } from "./register-provider.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { createFakeModelCatalog } from "../../../test/helpers/model-catalog.ts";

type EventRowReadback = Readonly<{
  id: string;
  subject_kind: string;
  subject_id: string;
  type: string;
  actor_kind: string;
  actor_id: string;
  payload_json: string;
}>;

const gitHttpBasicInput = {
  transport: "http-basic",
  forge: "github",
  username: "kanthord-bot",
  token: "ghp_x",
} as const;

const PROVIDER_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const REGISTERED_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const REMOVED_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Z";
const providerId = `provider_${PROVIDER_ULID}`;

const BLOB_HASH = "a".repeat(40);

describe("src/commands/provider/remove-provider.test", () => {
  const crypto: Crypto = new AesGcmCrypto({
    key: Buffer.alloc(32, 7),
    keyVersion: 1,
  });

  function registerDependencies(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
  ): RegisterProviderDependencies {
    return {
      storage,
      crypto,
      ids,
      clock,
      events: new SqliteEventLog({ storage, ids }),
      catalog: createFakeModelCatalog(),
    };
  }

  function removeDependencies(
    storage: Storage,
    events: EventLog,
  ): RemoveProviderDependencies {
    return { storage, events };
  }

  function registerGitProvider(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
  ): void {
    registerProvider(registerDependencies(storage, ids, clock), {
      name: "github-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });
  }

  function countRows(storage: Storage, table: "provider" | "event"): number {
    const row = storage.transact((transaction) =>
      transaction.get(`SELECT COUNT(*) AS c FROM ${table}`),
    ) as { c: number };
    return row.c;
  }

  function readEvents(storage: Storage): readonly EventRowReadback[] {
    return storage.transact((transaction) =>
      transaction.all(
        "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event",
      ),
    ) as readonly EventRowReadback[];
  }

  function seedProjectBinding(
    storage: Storage,
    projectId: string,
    projectName: string,
    kind: "provider" | "git",
    targetId: string,
  ): void {
    storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        [projectId, projectName, null, null, 1],
      );
      transaction.run(
        "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)",
        [projectId, kind, targetId, 1],
      );
    });
  }

  function seedRepository(
    storage: Storage,
    repositoryId: string,
    name: string,
    credentialId: string,
  ): void {
    storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO repository (id, name, remote_url, credential_id, home_path, branch, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          repositoryId,
          name,
          "https://example.invalid/r.git",
          credentialId,
          `repos/${repositoryId}.git`,
          "main",
          1,
          "ready",
          null,
          null,
          null,
          1,
        ],
      );
    });
  }

  function seedAttemptFixture(
    storage: Storage,
    credentialId: string,
    attemptIds: readonly string[],
  ): void {
    storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO blob (hash, size, content, created_at) VALUES (?, ?, ?, ?)",
        [BLOB_HASH, 1, Buffer.from("x"), 1],
      );
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["project_chain", "chain-project", null, null, 1],
      );
      transaction.run(
        "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)",
        [
          "revision_chain",
          "project_chain",
          null,
          "import_chain",
          BLOB_HASH,
          BLOB_HASH,
          BLOB_HASH,
        ],
      );
      transaction.run(
        "INSERT INTO repository (id, name, remote_url, credential_id, home_path, branch, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "repository_chain",
          "repo-chain",
          "https://example.invalid/rc.git",
          credentialId,
          "repos/chain.git",
          "main",
          1,
          "ready",
          null,
          null,
          null,
          1,
        ],
      );
      transaction.run(
        "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "node_initiative",
          "project_chain",
          "initiative",
          null,
          "Initiative",
          BLOB_HASH,
          null,
          null,
          null,
          "ready",
          null,
          null,
          "revision_chain",
          1,
        ],
      );
      transaction.run(
        "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "node_objective",
          "project_chain",
          "objective",
          "node_initiative",
          "Objective",
          BLOB_HASH,
          null,
          null,
          "repository_chain",
          "ready",
          null,
          null,
          "revision_chain",
          1,
        ],
      );
      transaction.run(
        "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "workspace_objective",
          "node_objective",
          "repository_chain",
          "workspaces/objective",
          BLOB_HASH,
          BLOB_HASH,
          BLOB_HASH,
          "coding/v1",
          null,
          "ready",
          1,
        ],
      );
      transaction.run(
        "INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "run_objective",
          "objective",
          "node_objective",
          null,
          "workspace_objective",
          "general@1",
          1,
          3,
          BLOB_HASH,
          null,
          "active",
          null,
          null,
        ],
      );
      for (const attemptId of attemptIds) {
        transaction.run(
          "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            `node_${attemptId}`,
            "project_chain",
            "task",
            "node_objective",
            "Task",
            BLOB_HASH,
            BLOB_HASH,
            null,
            null,
            "ready",
            null,
            null,
            "revision_chain",
            1,
          ],
        );
        transaction.run(
          "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            `workspace_${attemptId}`,
            `node_${attemptId}`,
            "repository_chain",
            `workspaces/${attemptId}`,
            BLOB_HASH,
            BLOB_HASH,
            BLOB_HASH,
            "coding/v1",
            null,
            "ready",
            1,
          ],
        );
        transaction.run(
          "INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            `run_${attemptId}`,
            "task",
            `node_${attemptId}`,
            "run_objective",
            `workspace_${attemptId}`,
            "general@1",
            1,
            3,
            BLOB_HASH,
            null,
            "active",
            null,
            null,
          ],
        );
        transaction.run(
          "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            attemptId,
            `run_${attemptId}`,
            1,
            credentialId,
            "claude-opus-5",
            60000,
            BLOB_HASH,
            "b".repeat(40),
            null,
            null,
          ],
        );
      }
    });
  }

  it("an unknown id refuses with not-found and writes no row and no event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const deps = removeDependencies(
      temporary.storage,
      new SqliteEventLog({
        storage: temporary.storage,
        ids: createMockIdGenerator({ ulids: [] }),
      }),
    );

    assert.throws(
      () => removeProvider(deps, { id: providerId, actor: "ulrich" }),
      (error: unknown) =>
        error instanceof RemoveProviderError &&
        error.refusal === "not-found" &&
        error.message === `no provider ${providerId}` &&
        Object.keys(error).sort().join(",") === "name,refusal",
    );
    assert.equal(countRows(temporary.storage, "provider"), 0);
    assert.equal(countRows(temporary.storage, "event"), 0);
  });

  it("a removal blocked by all four causes reports every blocker in category order and keeps the provider row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, REGISTERED_ULID],
    });
    registerGitProvider(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    temporary.storage.transact((transaction) => {
      transaction.run("UPDATE provider SET set_default_at = ? WHERE id = ?", [
        1700000000000,
        providerId,
      ]);
    });
    seedProjectBinding(
      temporary.storage,
      "project_p",
      "p-project",
      "provider",
      providerId,
    );
    seedAttemptFixture(temporary.storage, providerId, ["attempt_chain"]);
    const deps = removeDependencies(
      temporary.storage,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    assert.throws(
      () => removeProvider(deps, { id: providerId, actor: "ulrich" }),
      (error: unknown) => {
        assert.ok(error instanceof RemoveProviderError);
        assert.equal(error.refusal, "binding-in-use");
        assert.equal(error.message, `provider ${providerId} is still in use`);
        assert.equal(
          Object.keys(error).sort().join(","),
          "blockers,name,refusal",
        );
        assert.deepEqual(error.blockers, [
          { kind: "default-chain" },
          { kind: "project-binding", projectId: "project_p" },
          { kind: "repository", repositoryId: "repository_chain" },
          { kind: "attempt", attemptId: "attempt_chain" },
        ]);
        return true;
      },
    );
    assert.equal(countRows(temporary.storage, "provider"), 1);
    assert.equal(countRows(temporary.storage, "event"), 1);
  });

  it("two provider project bindings are listed in Buffer.compare order of project_id", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, REGISTERED_ULID],
    });
    registerGitProvider(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    seedProjectBinding(
      temporary.storage,
      "project_zaaa",
      "zeta-project",
      "provider",
      providerId,
    );
    seedProjectBinding(
      temporary.storage,
      "project_azzz",
      "alpha-project",
      "provider",
      providerId,
    );
    const deps = removeDependencies(
      temporary.storage,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    assert.throws(
      () => removeProvider(deps, { id: providerId, actor: "ulrich" }),
      (error: unknown) => {
        assert.ok(error instanceof RemoveProviderError);
        assert.deepEqual(error.blockers, [
          { kind: "project-binding", projectId: "project_azzz" },
          { kind: "project-binding", projectId: "project_zaaa" },
        ]);
        return true;
      },
    );
    assert.equal(countRows(temporary.storage, "provider"), 1);
  });

  it("two repository blockers are listed in ascending Buffer.compare order", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, REGISTERED_ULID],
    });
    registerGitProvider(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    seedRepository(temporary.storage, "repository_z", "repo-z", providerId);
    seedRepository(temporary.storage, "repository_a", "repo-a", providerId);
    const deps = removeDependencies(
      temporary.storage,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    assert.throws(
      () => removeProvider(deps, { id: providerId, actor: "ulrich" }),
      (error: unknown) => {
        assert.ok(error instanceof RemoveProviderError);
        assert.deepEqual(error.blockers, [
          { kind: "repository", repositoryId: "repository_a" },
          { kind: "repository", repositoryId: "repository_z" },
        ]);
        return true;
      },
    );
    assert.equal(countRows(temporary.storage, "provider"), 1);
  });

  it("two attempt blockers are listed in ascending Buffer.compare order", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, REGISTERED_ULID],
    });
    registerGitProvider(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    seedAttemptFixture(temporary.storage, providerId, [
      "attempt_z",
      "attempt_a",
    ]);
    const deps = removeDependencies(
      temporary.storage,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    assert.throws(
      () => removeProvider(deps, { id: providerId, actor: "ulrich" }),
      (error: unknown) => {
        assert.ok(error instanceof RemoveProviderError);
        assert.deepEqual(error.blockers, [
          { kind: "repository", repositoryId: "repository_chain" },
          { kind: "attempt", attemptId: "attempt_a" },
          { kind: "attempt", attemptId: "attempt_z" },
        ]);
        return true;
      },
    );
    assert.equal(countRows(temporary.storage, "provider"), 1);
  });

  it("a project binding of kind git naming the same target blocks nothing and the removal succeeds", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, REGISTERED_ULID, REMOVED_ULID],
    });
    registerGitProvider(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    seedProjectBinding(
      temporary.storage,
      "project_g",
      "g-project",
      "git",
      providerId,
    );
    const deps = removeDependencies(
      temporary.storage,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    assert.deepEqual(
      removeProvider(deps, { id: providerId, actor: "ulrich" }),
      {
        id: providerId,
      },
    );
    assert.equal(countRows(temporary.storage, "provider"), 0);
    assert.equal(countRows(temporary.storage, "event"), 2);
  });

  it("an unblocked removal deletes the row, returns only the id and appends provider.removed", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, REGISTERED_ULID, REMOVED_ULID],
    });
    registerGitProvider(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    const deps = removeDependencies(
      temporary.storage,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    assert.deepEqual(
      removeProvider(deps, { id: providerId, actor: "ulrich" }),
      {
        id: providerId,
      },
    );
    assert.equal(countRows(temporary.storage, "provider"), 0);
    const removed = readEvents(temporary.storage).filter(
      (event) =>
        event.subject_id === providerId && event.type === "provider.removed",
    );
    assert.equal(removed.length, 1);
    const event = removed[0]!;
    assert.equal(event.subject_kind, "provider");
    assert.equal(event.subject_id, providerId);
    assert.equal(event.type, "provider.removed");
    assert.equal(event.actor_kind, "human");
    assert.equal(event.actor_id, "ulrich");
    assert.equal(event.payload_json, '{"name":"github-bot","kind":"git"}');
    assert.equal(countRows(temporary.storage, "event"), 2);
  });

  it("a throwing event append leaves the provider row present", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, REGISTERED_ULID, REMOVED_ULID],
    });
    registerGitProvider(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    const inner = new SqliteEventLog({ storage: temporary.storage, ids });
    let appends = 0;
    const events: EventLog = {
      append(transaction, input) {
        appends++;
        if (appends === 1) {
          throw new Error("provider.removed append fails");
        }
        return inner.append(transaction, input);
      },
      list(filter, transaction) {
        return inner.list(filter, transaction);
      },
    };
    const deps = removeDependencies(temporary.storage, events);

    assert.throws(
      () => removeProvider(deps, { id: providerId, actor: "ulrich" }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "provider.removed append fails",
    );
    assert.equal(countRows(temporary.storage, "provider"), 1);
    assert.equal(countRows(temporary.storage, "event"), 1);
  });
});
