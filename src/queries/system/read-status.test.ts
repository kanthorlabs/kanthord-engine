import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readStatus } from "./read-status.ts";
import type { HealthResult } from "../../domain/health.ts";
import { systemStatusResponse } from "../../http/contract/system.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";

const NOW = 1700000000000;
const VERSION = "27.8.1";
const BIND = "127.0.0.1:7421";
const STARTED_AT = "2026-08-06T00:00:00.000Z";

const okHealth = (): HealthResult => ({ status: "ok", dependencies: [] });

function readFrom(
  temporary: ReturnType<typeof createMigratedStorage>,
  health: () => HealthResult = okHealth,
): ReturnType<typeof readStatus> {
  return readStatus({
    storage: temporary.storage,
    clock: createMockClock({ start: NOW }),
    health,
    version: VERSION,
    bind: BIND,
    startedAt: STARTED_AT,
  });
}

function insertNode(
  transaction: Parameters<typeof seedGraph>[0],
  id: string,
  state: string,
  blockReason: string | null,
): void {
  transaction.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      fixtureIds.project,
      "task",
      fixtureIds.objective,
      "Harden the verify CLI",
      fixtureIds.instructionBlob,
      fixtureIds.acceptanceBlob,
      null,
      null,
      state,
      blockReason,
      null,
      fixtureIds.planRevision,
      1,
    ],
  );
}

function insertLease(
  transaction: Parameters<typeof seedGraph>[0],
  subjectKind: "node" | "repository",
  subjectId: string,
  owner: string | null,
  expiresAt: number | null,
): void {
  transaction.run(
    "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, expires_at) VALUES (?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE 'daemon' END, ?, ?)",
    [subjectKind, subjectId, owner, owner, 1, expiresAt],
  );
}

describe("src/queries/system/read-status.test", () => {
  it("an empty database returns three empty arrays and copies version, bind and startedAt byte for byte", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const result = readFrom(temporary);

    assert.equal(result.version, VERSION);
    assert.equal(result.bind, BIND);
    assert.equal(result.startedAt, STARTED_AT);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.dependencies, []);
    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.repositories, []);
    assert.deepEqual(result.leases, []);
    assert.equal(systemStatusResponse.safeParse(result).success, true);
  });

  it("groups and orders nodes by kind, then state, then block reason", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      insertNode(transaction, "task_b", "blocked", "attempt-limit");
      insertNode(transaction, "task_c", "blocked", "stale-base");
    });

    const result = readFrom(temporary);

    assert.deepEqual(
      result.nodes.map((row) => ({ ...row })),
      [
        { kind: "initiative", state: "pending", blockReason: null, count: 1 },
        { kind: "objective", state: "pending", blockReason: null, count: 1 },
        {
          kind: "task",
          state: "blocked",
          blockReason: "attempt-limit",
          count: 1,
        },
        { kind: "task", state: "blocked", blockReason: "stale-base", count: 1 },
        { kind: "task", state: "pending", blockReason: null, count: 1 },
      ],
    );
    assert.equal(systemStatusResponse.safeParse(result).success, true);
  });

  it("returns only needs-reconcile repositories with both diverged object ids", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      transaction.run(
        "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "repo_b",
          "needs-reconcile-repo",
          "https://example.invalid/other.git",
          fixtureIds.provider,
          "repos/other.git",
          "main",
          "main",
          "refs/heads/main",
          1,
          "needs-reconcile",
          "a".repeat(40),
          "b".repeat(40),
          null,
          1,
        ],
      );
    });

    const result = readFrom(temporary);

    assert.deepEqual(
      result.repositories.map((row) => ({ ...row })),
      [
        {
          id: "repo_b",
          name: "needs-reconcile-repo",
          divergedLandingOid: "a".repeat(40),
          divergedUpstreamOid: "b".repeat(40),
        },
      ],
    );
    assert.equal(systemStatusResponse.safeParse(result).success, true);
  });

  it("returns only expired leases and the expiry boundary is inclusive", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      insertLease(transaction, "node", "lease_a", "owner-a", NOW - 1);
      insertLease(transaction, "node", "lease_b", "owner-b", NOW);
      insertLease(transaction, "node", "lease_c", "owner-c", NOW + 1);
      insertLease(transaction, "node", "lease_d", "owner-d", null);
    });

    const result = readFrom(temporary);

    assert.deepEqual(
      result.leases.map((lease) => lease.subjectId),
      ["lease_a", "lease_b"],
    );
    assert.equal(systemStatusResponse.safeParse(result).success, true);
  });

  it("orders leases by subject_kind then subject_id", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      insertLease(transaction, "repository", "repo_lease", "owner-a", NOW - 1);
      insertLease(transaction, "node", "node_b", "owner-b", NOW - 1);
      insertLease(transaction, "node", "node_a", "owner-c", NOW - 1);
    });

    const result = readFrom(temporary);

    assert.deepEqual(
      result.leases.map((lease) => [lease.subjectKind, lease.subjectId]),
      [
        ["node", "node_a"],
        ["node", "node_b"],
        ["repository", "repo_lease"],
      ],
    );
    assert.equal(systemStatusResponse.safeParse(result).success, true);
  });

  it("carries a null owner through to the result", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      insertLease(transaction, "node", "lease_x", null, NOW - 1);
    });

    const result = readFrom(temporary);

    assert.equal(result.leases.length, 1);
    assert.equal(result.leases[0]?.owner, null);
    assert.equal(systemStatusResponse.safeParse(result).success, true);
  });

  it("calls the injected health exactly once and passes its result through", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    let calls = 0;
    const health = (): HealthResult => {
      calls += 1;
      return { status: "ok", dependencies: [] };
    };

    const result = readFrom(temporary, health);

    assert.equal(calls, 1);
    assert.equal(result.status, "ok");
    assert.deepEqual(result.dependencies, []);
    assert.equal(systemStatusResponse.safeParse(result).success, true);
  });

  it("a degraded health result reaches the response unchanged", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const health = (): HealthResult => ({
      status: "degraded",
      dependencies: [{ name: "storage", status: "failed" }],
    });

    const result = readFrom(temporary, health);

    assert.equal(result.status, "degraded");
    assert.deepEqual(result.dependencies, [
      { name: "storage", status: "failed" },
    ]);
    assert.equal(systemStatusResponse.safeParse(result).success, true);
  });
});
