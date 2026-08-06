import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createMigratedStorage } from "../../../test/helpers/database.ts";
import type { TemporaryStorage } from "../../../test/helpers/database.ts";
import { gitOperationRow } from "../../domain/git-operation.ts";
import { createGitJournal } from "./journal.ts";
import { JournalError } from "./index.ts";
import type { OpenJournalRowInput } from "./index.ts";
import type { Storage } from "../storage/index.ts";

const REPOSITORY_ID = "repo_01J0AAAAAAAAAAAAAAAAAAAAAA";
const HOME_PATH = "/tmp/fixture.git";

const storages: TemporaryStorage[] = [];

after(() => {
  for (const temporary of storages) {
    temporary.dispose();
  }
});

function makeStorage(): Storage {
  const temporary = createMigratedStorage();
  storages.push(temporary);
  seedRepository(temporary.storage);
  return temporary.storage;
}

function seedRepository(storage: Storage): void {
  storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "provider_fixture",
        "fixture",
        "git",
        null,
        new Uint8Array([1]),
        new Uint8Array(12),
        new Uint8Array(16),
        1,
        1,
      ],
    );
    transaction.run(
      "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        REPOSITORY_ID,
        "fixture",
        "https://example.invalid/r.git",
        "provider_fixture",
        HOME_PATH,
        "main",
        "main",
        "refs/heads/main",
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

function gitopId(marker: "A" | "B" | "C"): string {
  return `gitop_01J0${marker.repeat(22)}`;
}

function makeOpen(id: string): OpenJournalRowInput {
  return {
    id,
    repositoryId: REPOSITORY_ID,
    intent: "merge",
    nodeId: null,
    runId: null,
    candidateId: null,
    leaseFence: 0,
    ref: "refs/heads/main",
    baseOid: "a".repeat(40),
    proposedHeadOid: "b".repeat(40),
    expectedRemoteOid: null,
    childToken: `gitop-${id}.pid`,
  };
}

function rowToDomain(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    intent: row.intent,
    nodeId: row.node_id,
    runId: row.run_id,
    candidateId: row.candidate_id,
    leaseFence: row.lease_fence,
    ref: row.ref,
    baseOid: row.base_oid,
    proposedHeadOid: row.proposed_head_oid,
    resultHeadOid: row.result_head_oid,
    expectedRemoteOid: row.expected_remote_oid,
    state: row.state,
    outcome: row.outcome,
    detailBlob: row.detail_blob,
    childToken: row.child_token,
    completedAt: row.completed_at,
  };
}

describe("src/services/git/journal.test", () => {
  it("open then listInFlight returns the row with the home path joined", () => {
    const storage = makeStorage();
    const journal = createGitJournal();
    storage.transact((transaction) => {
      journal.open(transaction, makeOpen(gitopId("A")));
      const rows = journal.listInFlight(transaction);
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0], {
        id: gitopId("A"),
        repositoryId: REPOSITORY_ID,
        repositoryHomePath: HOME_PATH,
        intent: "merge",
        ref: "refs/heads/main",
        baseOid: "a".repeat(40),
        proposedHeadOid: "b".repeat(40),
        childToken: `gitop-${gitopId("A")}.pid`,
      });
    });
  });

  it("open stores expected_remote_oid for a publish row", () => {
    const storage = makeStorage();
    const journal = createGitJournal();
    storage.transact((transaction) => {
      const id = gitopId("A");
      journal.open(transaction, {
        ...makeOpen(id),
        intent: "publish",
        expectedRemoteOid: "c".repeat(40),
      });
      const row = transaction.get(
        "SELECT expected_remote_oid FROM git_operation WHERE id = ?",
        [id],
      ) as { expected_remote_oid: string | null };
      assert.equal(row.expected_remote_oid, "c".repeat(40));
    });
  });

  it("complete writes the terminal columns and returns the previous token", () => {
    const storage = makeStorage();
    const journal = createGitJournal();
    storage.transact((transaction) => {
      const id = gitopId("A");
      journal.open(transaction, makeOpen(id));
      const cleared = journal.complete(transaction, {
        id,
        resultHeadOid: "d".repeat(40),
        outcome: "ok",
        completedAt: 1700000000000,
      });
      assert.equal(cleared, `gitop-${id}.pid`);
      const row = transaction.get(
        "SELECT state, result_head_oid, child_token, completed_at FROM git_operation WHERE id = ?",
        [id],
      ) as {
        state: string;
        result_head_oid: string | null;
        child_token: string | null;
        completed_at: number | null;
      };
      assert.equal(row.state, "complete");
      assert.equal(row.result_head_oid, "d".repeat(40));
      assert.equal(row.child_token, null);
      assert.equal(row.completed_at, 1700000000000);
    });
  });

  it("discard leaves result_head_oid null and returns the previous token", () => {
    const storage = makeStorage();
    const journal = createGitJournal();
    storage.transact((transaction) => {
      const id = gitopId("A");
      journal.open(transaction, makeOpen(id));
      const cleared = journal.discard(transaction, {
        id,
        outcome: "discarded",
        completedAt: 1700000000000,
      });
      assert.equal(cleared, `gitop-${id}.pid`);
      const row = transaction.get(
        "SELECT state, result_head_oid, child_token FROM git_operation WHERE id = ?",
        [id],
      ) as {
        state: string;
        result_head_oid: string | null;
        child_token: string | null;
      };
      assert.equal(row.state, "discarded");
      assert.equal(row.result_head_oid, null);
      assert.equal(row.child_token, null);
    });
  });

  it("complete on a completed row throws JournalError with code journal-row-not-open", () => {
    const storage = makeStorage();
    const journal = createGitJournal();
    storage.transact((transaction) => {
      const id = gitopId("A");
      journal.open(transaction, makeOpen(id));
      journal.complete(transaction, {
        id,
        resultHeadOid: "d".repeat(40),
        outcome: "ok",
        completedAt: 1700000000000,
      });
      assert.throws(
        () =>
          journal.complete(transaction, {
            id,
            resultHeadOid: "e".repeat(40),
            outcome: "again",
            completedAt: 1700000001000,
          }),
        (error: unknown) =>
          error instanceof JournalError &&
          error.code === "journal-row-not-open" &&
          error.name === "JournalError",
      );
    });
  });

  it("markPublishPending keeps the row open and returns the previous token", () => {
    const storage = makeStorage();
    const journal = createGitJournal();
    storage.transact((transaction) => {
      const id = gitopId("A");
      journal.open(transaction, makeOpen(id));
      const cleared = journal.markPublishPending(transaction, {
        id,
        outcome: "awaiting-remote-reconcile",
      });
      assert.equal(cleared, `gitop-${id}.pid`);
      const row = transaction.get(
        "SELECT state, outcome, completed_at, child_token FROM git_operation WHERE id = ?",
        [id],
      ) as {
        state: string;
        outcome: string | null;
        completed_at: number | null;
        child_token: string | null;
      };
      assert.equal(row.state, "open");
      assert.equal(row.outcome, "awaiting-remote-reconcile");
      assert.equal(row.completed_at, null);
      assert.equal(row.child_token, null);
    });
  });

  it("clearChildToken leaves the row open and a second call returns null", () => {
    const storage = makeStorage();
    const journal = createGitJournal();
    storage.transact((transaction) => {
      const id = gitopId("A");
      journal.open(transaction, makeOpen(id));
      assert.equal(
        journal.clearChildToken(transaction, { id }),
        `gitop-${id}.pid`,
      );
      assert.equal(journal.clearChildToken(transaction, { id }), null);
      const row = transaction.get(
        "SELECT state, outcome, completed_at, child_token FROM git_operation WHERE id = ?",
        [id],
      ) as {
        state: string;
        outcome: string | null;
        completed_at: number | null;
        child_token: string | null;
      };
      assert.equal(row.state, "open");
      assert.equal(row.outcome, null);
      assert.equal(row.completed_at, null);
      assert.equal(row.child_token, null);
    });
  });

  it("the module touches no filesystem", () => {
    const source = readFileSync(
      new URL("./journal.ts", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("node:fs"), false);
    assert.equal(source.includes("rmSync"), false);
  });

  it("listInFlight excludes complete and token-less rows while listOpen includes the token-less row", () => {
    const storage = makeStorage();
    const journal = createGitJournal();
    storage.transact((transaction) => {
      const a = gitopId("A");
      const b = gitopId("B");
      const c = gitopId("C");
      journal.open(transaction, makeOpen(a));
      journal.open(transaction, makeOpen(b));
      journal.open(transaction, makeOpen(c));
      journal.complete(transaction, {
        id: b,
        resultHeadOid: "d".repeat(40),
        outcome: "ok",
        completedAt: 1700000000000,
      });
      journal.clearChildToken(transaction, { id: c });
      assert.deepEqual(
        journal.listInFlight(transaction).map((row) => row.id),
        [a],
      );
      assert.deepEqual(
        journal.listOpen(transaction).map((row) => row.id),
        [a, c],
      );
    });
  });

  it("listInFlight orders by id and every row satisfies the domain refinement", () => {
    const storage = makeStorage();
    const journal = createGitJournal();
    storage.transact((transaction) => {
      const a = gitopId("A");
      const b = gitopId("B");
      const c = gitopId("C");
      journal.open(transaction, makeOpen(c));
      journal.open(transaction, makeOpen(b));
      journal.open(transaction, makeOpen(a));
      assert.deepEqual(
        journal.listInFlight(transaction).map((row) => row.id),
        [a, b, c],
      );
      const raw = transaction.all(
        "SELECT * FROM git_operation ORDER BY id",
      ) as readonly Record<string, unknown>[];
      assert.equal(raw.length, 3);
      for (const row of raw) {
        assert.doesNotThrow(() => gitOperationRow.parse(rowToDomain(row)));
      }
    });
  });
});
