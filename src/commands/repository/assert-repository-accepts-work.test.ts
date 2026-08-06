import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRecoveryFixture } from "../../../test/helpers/recovery.ts";
import type { RecoveryFixture } from "../../../test/helpers/recovery.ts";
import {
  assertRepositoryAcceptsWork,
  type RepositoryWorkVerdict,
} from "./assert-repository-accepts-work.ts";

const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPOSITORY_B = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const BASE = "a".repeat(40);
const HEAD_OID = "b".repeat(40);

function openRow(
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id,
    repository_id: REPOSITORY_ID,
    intent: "merge",
    node_id: null,
    run_id: null,
    candidate_id: null,
    lease_fence: 0,
    ref: "refs/heads/main",
    base_oid: BASE,
    proposed_head_oid: HEAD_OID,
    expected_remote_oid: null,
    child_token: null,
    state: "open",
    result_head_oid: null,
    outcome: null,
    detail_blob: null,
    completed_at: null,
    ...overrides,
  };
}

function verdict(
  fixture: RecoveryFixture,
  repositoryId: string,
): RepositoryWorkVerdict {
  return fixture.storage.transact((transaction) =>
    assertRepositoryAcceptsWork(transaction, { repositoryId }),
  );
}

describe("src/commands/repository/assert-repository-accepts-work.test", () => {
  it("a repository with no git_operation row accepts work", (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    assert.deepEqual(verdict(fixture, REPOSITORY_ID), { accepts: true });
  });

  it("an open publish row refuses work with publish-reconcile-pending", (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    fixture.seedGitOperation(
      openRow("gitop_01J0AAAAAAAAAAAAAAAAAAAAAA", {
        intent: "publish",
        ref: "refs/heads/kanthord/publish",
      }),
    );
    assert.deepEqual(verdict(fixture, REPOSITORY_ID), {
      accepts: false,
      reason: "publish-reconcile-pending",
      gitOperationId: "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("an open merge row accepts work — the guard is about publish only", (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    fixture.seedGitOperation(openRow("gitop_01J0AAAAAAAAAAAAAAAAAAAAAA"));
    assert.deepEqual(verdict(fixture, REPOSITORY_ID), { accepts: true });
  });

  it("a complete publish row accepts work", (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    fixture.seedGitOperation(
      openRow("gitop_01J0AAAAAAAAAAAAAAAAAAAAAA", {
        intent: "publish",
        ref: "refs/heads/kanthord/publish",
        state: "complete",
        result_head_oid: HEAD_OID,
        outcome: "published",
        completed_at: 1700000000000,
      }),
    );
    assert.deepEqual(verdict(fixture, REPOSITORY_ID), { accepts: true });
  });

  it("two open publish rows refuse on the bytewise-lowest id", (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    fixture.seedGitOperation(
      openRow("gitop_01J0BBBBBBBBBBBBBBBBBBBBBB", {
        intent: "publish",
        ref: "refs/heads/kanthord/publish",
      }),
    );
    fixture.seedGitOperation(
      openRow("gitop_01J0AAAAAAAAAAAAAAAAAAAAAA", {
        intent: "publish",
        ref: "refs/heads/kanthord/publish",
      }),
    );
    assert.deepEqual(verdict(fixture, REPOSITORY_ID), {
      accepts: false,
      reason: "publish-reconcile-pending",
      gitOperationId: "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("a publish row of another repository does not refuse this one", (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture-a",
      homePath: "/run/kanthord/repos/fixture-a.git",
    });
    fixture.seedRepository({
      id: REPOSITORY_B,
      name: "fixture-b",
      homePath: "/run/kanthord/repos/fixture-b.git",
    });
    fixture.seedGitOperation(
      openRow("gitop_01J0AAAAAAAAAAAAAAAAAAAAAA", {
        repository_id: REPOSITORY_B,
        intent: "publish",
        ref: "refs/heads/kanthord/publish",
      }),
    );
    assert.deepEqual(verdict(fixture, REPOSITORY_ID), { accepts: true });
    assert.deepEqual(verdict(fixture, REPOSITORY_B), {
      accepts: false,
      reason: "publish-reconcile-pending",
      gitOperationId: "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("the verdict writes nothing", (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/run/kanthord/repos/fixture.git",
    });
    fixture.seedGitOperation(
      openRow("gitop_01J0AAAAAAAAAAAAAAAAAAAAAA", {
        intent: "publish",
        ref: "refs/heads/kanthord/publish",
      }),
    );
    const before = fixture.storage.transact((transaction) => ({
      events: transaction.get("SELECT count(*) AS count FROM event") as {
        count: number;
      },
      row: transaction.get("SELECT * FROM git_operation WHERE id = ?", [
        "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA",
      ]),
    }));
    assert.deepEqual(verdict(fixture, REPOSITORY_ID), {
      accepts: false,
      reason: "publish-reconcile-pending",
      gitOperationId: "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA",
    });
    const after = fixture.storage.transact((transaction) => ({
      events: transaction.get("SELECT count(*) AS count FROM event") as {
        count: number;
      },
      row: transaction.get("SELECT * FROM git_operation WHERE id = ?", [
        "gitop_01J0AAAAAAAAAAAAAAAAAAAAAA",
      ]),
    }));
    assert.deepEqual(after, before);
  });
});
