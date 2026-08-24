import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../../../test/helpers/database.ts";
import { proposalStatements } from "../../../test/helpers/proposal.ts";
import {
  fixtureIds,
  seedExecution,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import { coreEntities } from "./migration-0001-core-entities.ts";
import { graphAndPlan } from "./migration-0002-graph-and-plan.ts";
import { executionAndJournal } from "./migration-0003-execution-and-journal.ts";
import { migration0004EventIndexes } from "./migration-0004-event-indexes.ts";
import { migration0005Actor } from "./migration-0005-actor.ts";
import { migration0006RevisionOrigin } from "./migration-0006-revision-origin.ts";
import { migration0007ExternalExecution } from "./migration-0007-external-execution.ts";
import { migration0008GraphIndexes } from "./migration-0008-graph-indexes.ts";
import { migration0009OneBranch } from "./migration-0009-one-branch.ts";
import { migrations } from "./migrations.ts";
import { SqliteStorage } from "./sqlite.ts";

const AGENT_KINDS = ["general@1", "swe@1", "te@1", "re@1"] as const;

const ATTEMPT_OUTCOMES = [
  "accepted",
  "rejected",
  "failed",
  "timed-out",
  "cancelled",
] as const;

const CANDIDATE_SUBJECT_KINDS = [
  "candidate",
  "merge",
  "task-diagnostic",
  "reconcile",
  "profile-gate",
  "initiative-e2e",
] as const;

const CHECK_RESULTS = [
  "running",
  "passed",
  "failed",
  "error",
  "timed-out",
  "cancelled",
  "not-applicable",
] as const;

const unstoredHash = `sha256:${"f".repeat(64)}`;

const normalize = (sql: string): readonly string[] =>
  sql
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);

const historicalLeaseStatement =
  normalize(`CREATE TABLE lease (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('node', 'repository')),
  subject_id   TEXT NOT NULL,
  owner        TEXT,
  fence        INTEGER NOT NULL,
  acquired_at  INTEGER,
  renewed_at   INTEGER,
  expires_at   INTEGER,
  PRIMARY KEY (subject_kind, subject_id)
) STRICT`)[0] ?? "";

const historicalRunStatements = [
  ...normalize(`CREATE TABLE run (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('objective', 'task')),
  node_id       TEXT NOT NULL REFERENCES node(id),
  parent_run_id TEXT REFERENCES run(id),
  workspace_id  TEXT NOT NULL REFERENCES workspace(id),
  worker        TEXT NOT NULL,
  lease_fence   INTEGER NOT NULL,
  attempt_limit INTEGER NOT NULL,
  base_oid      TEXT NOT NULL,
  head_oid      TEXT,
  state         TEXT NOT NULL CHECK (state IN ('active', 'ended')),
  outcome       TEXT,
  ended_at      INTEGER,
  CHECK ((kind = 'objective') = (parent_run_id IS NULL))
) STRICT`),
  ...normalize(
    `CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active'`,
  ),
];

const historicalAttemptStatement =
  normalize(`CREATE TABLE attempt (
  id             TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES run(id),
  attempt_no     INTEGER NOT NULL,
  provider_id    TEXT NOT NULL REFERENCES provider(id),
  provider_model TEXT NOT NULL,
  timeout_ms     INTEGER NOT NULL,
  base_oid       TEXT NOT NULL,
  head_oid       TEXT,
  outcome        TEXT CHECK (outcome IS NULL OR outcome IN
                 ('accepted', 'rejected', 'failed', 'timed-out', 'cancelled')),
  ended_at       INTEGER,
  UNIQUE (run_id, attempt_no)
) STRICT`)[0] ?? "";

const historicalEventStatement =
  normalize(`CREATE TABLE event (
  id           TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('human', 'daemon')),
  actor_id     TEXT NOT NULL,
  payload_json TEXT NOT NULL
) STRICT`)[0] ?? "";

type Context = Readonly<{
  storage: SqliteStorage;
  temporary: TemporaryDatabase;
}>;

const buildMigrated = (): Context => {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000 }),
    migrations,
  });
  storage.migrate();
  storage.transact((t) => {
    seedRegistry(t);
    seedGraph(t);
    seedExecution(t);
  });
  return { storage, temporary };
};

const countRows = (storage: SqliteStorage, table: string): number => {
  const row = storage.transact((t) =>
    t.get(`SELECT COUNT(*) AS c FROM ${table}`),
  ) as { c: number };
  return row.c;
};

const assertRefused = (
  storage: SqliteStorage,
  fn: () => void,
  table: string,
  options: { message?: string } = {},
): void => {
  const before = countRows(storage, table);
  let thrown: unknown;
  try {
    fn();
    assert.fail("expected a throw");
  } catch (error) {
    thrown = error;
  }
  assert.equal((thrown as { errcode: number }).errcode & 0xff, 19);
  assert.equal(countRows(storage, table), before);
  if (options.message !== undefined) {
    assert.ok(
      (thrown as { message: string }).message.includes(options.message),
    );
  }
};

const endTaskRun = (storage: SqliteStorage): void => {
  storage.transact((t) => {
    t.run("UPDATE run SET state = 'ended' WHERE id = ?", [fixtureIds.taskRun]);
  });
};

type RunValues = Readonly<{
  id: string;
  kind?: string;
  nodeId?: string;
  parentRunId?: string | null;
  workspaceId?: string;
  state?: string;
}>;

const insertRun = (storage: SqliteStorage, values: RunValues): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        values.kind ?? "task",
        values.nodeId ?? fixtureIds.task,
        values.parentRunId ?? fixtureIds.objectiveRun,
        values.workspaceId ?? fixtureIds.workspace,
        "general@1",
        1,
        3,
        "a".repeat(40),
        null,
        values.state ?? "active",
        null,
        null,
      ],
    );
  });
};

type WorkspaceValues = Readonly<{
  id: string;
  nodeId?: string;
  profileBlob?: string;
  ambientBlob?: string | null;
  state?: string;
}>;

const insertWorkspace = (
  storage: SqliteStorage,
  values: WorkspaceValues,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        values.nodeId ?? fixtureIds.task,
        fixtureIds.repository,
        "workspaces/task_a",
        "a".repeat(40),
        "a".repeat(40),
        values.profileBlob ?? fixtureIds.profileBlob,
        "coding/v1",
        values.ambientBlob ?? null,
        values.state ?? "ready",
        1,
      ],
    );
  });
};

type AttemptValues = Readonly<{
  id: string;
  runId?: string;
  attemptNo?: number;
  providerId?: string;
  outcome?: string | null;
}>;

const insertAttempt = (storage: SqliteStorage, values: AttemptValues): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        values.runId ?? fixtureIds.taskRun,
        values.attemptNo ?? 1,
        values.providerId ?? fixtureIds.provider,
        "claude-opus-5",
        60000,
        "a".repeat(40),
        null,
        values.outcome ?? null,
        null,
      ],
    );
  });
};

type InvocationValues = Readonly<{
  id: string;
  agent?: string;
  verdict?: string | null;
}>;

const insertInvocation = (
  storage: SqliteStorage,
  values: InvocationValues,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO agent_invocation (id, attempt_id, agent, adapter_version, prompt_blob, sources_json, tool_definitions_blob, tool_trace_blob, diff_blob, verdict, reason_blob, usage_json, error_blob, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        fixtureIds.attempt,
        values.agents ?? "general@1",
        "pi-coding-agent/1",
        fixtureIds.instructionBlob,
        "{}",
        fixtureIds.instructionBlob,
        null,
        null,
        values.verdict ?? null,
        null,
        null,
        null,
        null,
      ],
    );
  });
};

type CandidateValues = Readonly<{
  id: string;
  revision?: string;
  projectedOutcome?: string;
  state?: string;
  acknowledgedPartial?: number | null;
}>;

const insertCandidate = (
  storage: SqliteStorage,
  values: CandidateValues,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO candidate (id, node_id, run_id, workspace_id, revision, candidate_oid, landing_base_oid, merge_oid, projected_outcome, evidence_blob, profile_blob, convention_version, state, acknowledged_partial, publish_requested, approved_actor, approved_at, invalidated_at, invalidated_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        fixtureIds.objective,
        fixtureIds.objectiveRun,
        fixtureIds.workspace,
        values.revision ?? "cand-1",
        "c".repeat(40),
        "a".repeat(40),
        null,
        values.projectedOutcome ?? "done",
        fixtureIds.instructionBlob,
        fixtureIds.profileBlob,
        "coding/v1",
        values.state ?? "open",
        values.acknowledgedPartial ?? null,
        null,
        null,
        null,
        null,
        null,
        1,
      ],
    );
  });
};

type CheckValues = Readonly<{
  id: string;
  subjectKind?: string;
  commitOid?: string | null;
  manifestBlob?: string | null;
  result?: string;
}>;

const insertCheck = (storage: SqliteStorage, values: CheckValues): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO check_result (id, subject_kind, subject_id, node_id, run_id, commit_oid, manifest_blob, check_name, command_json, cwd, env_identity, toolchain_version, timeout_ms, authoritative, result, exit_code, output_blob, profile_blob, convention_version, invalidated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        values.subjectKind ?? "task-diagnostic",
        null,
        fixtureIds.task,
        fixtureIds.taskRun,
        values.commitOid === undefined ? "d".repeat(40) : values.commitOid,
        values.manifestBlob === undefined ? null : values.manifestBlob,
        "unit",
        "[]",
        "/tmp",
        "env",
        "node/24",
        60000,
        1,
        values.result ?? "running",
        null,
        null,
        null,
        "coding/v1",
        null,
        null,
      ],
    );
  });
};

type LeaseValues = Readonly<{
  subjectKind?: string;
  subjectId?: string;
}>;

const insertLease = (
  storage: SqliteStorage,
  values: LeaseValues = {},
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO lease (subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        values.subjectKind ?? "node",
        values.subjectId ?? "lease_sub",
        null,
        1,
        null,
        null,
        null,
      ],
    );
  });
};

type GitOperationValues = Readonly<{
  id: string;
  intent?: string;
  state?: string;
  outcome?: string | null;
}>;

const insertGitOperation = (
  storage: SqliteStorage,
  values: GitOperationValues,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO git_operation (id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        fixtureIds.repository,
        values.intent ?? "merge",
        null,
        null,
        null,
        1,
        "refs/heads/main",
        "a".repeat(40),
        "b".repeat(40),
        null,
        null,
        values.state ?? "open",
        values.outcome ?? null,
        null,
        null,
      ],
    );
  });
};

type EventValues = Readonly<{
  id: string;
  actorKind?: string;
}>;

const insertEvent = (storage: SqliteStorage, values: EventValues): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        "task",
        fixtureIds.task,
        "task.done",
        values.actorKind ?? "daemon",
        "daemon_a",
        "{}",
      ],
    );
  });
};

describe("src/services/storage/migration-0003-execution-and-journal.test", () => {
  it("parity: the ten statements reproduce the nine proposal tables verbatim, in order", () => {
    assert.deepEqual(executionAndJournal.statements.flatMap(normalize), [
      ...proposalStatements("workspace"),
      historicalLeaseStatement,
      ...historicalRunStatements,
      historicalAttemptStatement,
      ...[
        "agent_invocation",
        "candidate",
        "check_result",
        "git_operation",
      ].flatMap(proposalStatements),
      historicalEventStatement,
    ]);
  });

  it("executionAndJournal carries version 3 and the name migration.md declares", () => {
    assert.equal(executionAndJournal.version, 3);
    assert.equal(executionAndJournal.name, "0003-execution-and-journal");

    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const migrationDoc = fs.readFileSync(
      join(repositoryRoot, "docs", "proposal", "database", "migration.md"),
      "utf8",
    );
    assert.ok(migrationDoc.includes("0003-execution-and-journal"));
  });

  it("migrations holds exactly the nine migrations and versions map to 1, 2, 3, 4, 5, 6, 7, 8, 9", () => {
    assert.deepEqual(migrations, [
      coreEntities,
      graphAndPlan,
      executionAndJournal,
      migration0004EventIndexes,
      migration0005Actor,
      migration0006RevisionOrigin,
      migration0007ExternalExecution,
      migration0008GraphIndexes,
      migration0009OneBranch,
    ]);
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
  });

  it("no trigger or view exists", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const rows = storage.transact((t) =>
      t.all(
        "SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view')",
      ),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(rows, []);
  });

  it("the table inventory maps to the twenty names in order", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const rows = storage.transact((t) =>
      t.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(
      rows.map((row) => row.name),
      [
        "actor",
        "agent_invocation",
        "attempt",
        "blob",
        "candidate",
        "check_result",
        "edge",
        "event",
        "git_operation",
        "lease",
        "migration",
        "node",
        "plan_revision",
        "profile",
        "project",
        "project_binding",
        "provider",
        "repository",
        "run",
        "workspace",
      ],
    );
  });

  it("all nineteen product tables are STRICT", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    for (const table of [
      "actor",
      "agent_invocation",
      "attempt",
      "blob",
      "candidate",
      "check_result",
      "edge",
      "event",
      "git_operation",
      "lease",
      "node",
      "plan_revision",
      "profile",
      "project",
      "project_binding",
      "provider",
      "repository",
      "run",
      "workspace",
    ]) {
      const row = storage.transact((t) =>
        t.get("SELECT sql FROM sqlite_master WHERE name = ?", [table]),
      ) as { sql: string };
      assert.ok(String(row.sql).trimEnd().endsWith("STRICT"), table);
    }
  });

  it("the index inventory is exactly run_one_active plus the event indexes and the graph indexes", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const rows = storage.transact((t) =>
      t.all(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(
      rows.map((row) => row.name),
      [
        "edge_from_node",
        "event_actor",
        "event_subject",
        "event_type",
        "node_project",
        "run_one_active",
      ],
    );
  });

  it("run_one_active refuses a second active run for the same node", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertRun(storage, { id: "run_active_dup" }),
      "run",
      { message: "UNIQUE constraint failed: run.node_id" },
    );
  });

  it("run_one_active admits a new active run once the old one ended", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    endTaskRun(storage);
    insertRun(storage, { id: "run_active_after" });
    assert.equal(countRows(storage, "run"), 3);
  });

  it("two ended runs for one node coexist", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    endTaskRun(storage);
    insertRun(storage, { id: "run_ended_a", state: "ended" });
    insertRun(storage, { id: "run_ended_b", state: "ended" });
    assert.equal(countRows(storage, "run"), 4);
  });

  it("run refuses an objective kind with a parent and a task kind without one", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertRun(storage, {
          id: "run_obj_parent",
          kind: "objective",
          nodeId: fixtureIds.objective,
          parentRunId: fixtureIds.objectiveRun,
        }),
      "run",
    );
    assertRefused(
      storage,
      () => insertRun(storage, { id: "run_task_noparent", parentRunId: null }),
      "run",
    );
  });

  it("run refuses a state outside active and ended, and a kind outside objective and task", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertRun(storage, { id: "run_paused", state: "paused" }),
      "run",
    );
    assertRefused(
      storage,
      () => insertRun(storage, { id: "run_epic", kind: "epic" }),
      "run",
    );
  });

  it("run refuses a parent_run_id or workspace_id without a row", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    endTaskRun(storage);
    assertRefused(
      storage,
      () =>
        insertRun(storage, { id: "run_badparent", parentRunId: "run_missing" }),
      "run",
      { message: "FOREIGN KEY constraint failed" },
    );
    assertRefused(
      storage,
      () =>
        insertRun(storage, {
          id: "run_badws",
          workspaceId: "workspace_missing",
        }),
      "run",
      { message: "FOREIGN KEY constraint failed" },
    );
  });

  it("workspace refuses an unstored profile_blob and accepts a stored one", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertWorkspace(storage, {
          id: "workspace_bad",
          profileBlob: unstoredHash,
        }),
      "workspace",
      { message: "FOREIGN KEY constraint failed" },
    );
    insertWorkspace(storage, {
      id: "workspace_ok",
      profileBlob: fixtureIds.profileBlob,
    });
    assert.equal(countRows(storage, "workspace"), 2);
  });

  it("workspace ambient_blob accepts null and refuses an unstored hash", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertWorkspace(storage, {
          id: "workspace_bad",
          ambientBlob: unstoredHash,
        }),
      "workspace",
      { message: "FOREIGN KEY constraint failed" },
    );
    insertWorkspace(storage, { id: "workspace_null" });
    assert.equal(countRows(storage, "workspace"), 2);
  });

  it("workspace refuses a second row for the same node_id", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertWorkspace(storage, {
          id: "workspace_dup",
          nodeId: fixtureIds.objective,
        }),
      "workspace",
      { message: "UNIQUE constraint failed: workspace.node_id" },
    );
  });

  it("workspace state accepts any string", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertWorkspace(storage, { id: "workspace_free", state: "anything" });
    assert.equal(countRows(storage, "workspace"), 2);
  });

  it("agent_invocation accepts each of the frozen four agent kinds", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const before = countRows(storage, "agent_invocation");
    AGENT_KINDS.forEach((agent, index) => {
      insertInvocation(storage, { id: `inv_agent_${index}`, agent });
    });
    assert.equal(
      countRows(storage, "agent_invocation"),
      before + AGENT_KINDS.length,
    );
  });

  it("agent_invocation refuses an agent kind outside the frozen four", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertInvocation(storage, { id: "inv_mr", agent: "mr@1" }),
      "agent_invocation",
    );
    assertRefused(
      storage,
      () => insertInvocation(storage, { id: "inv_tdd", agent: "tdd@1" }),
      "agent_invocation",
    );
  });

  it("agent_invocation verdict accepts null, accept and reject and refuses maybe", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertInvocation(storage, { id: "inv_maybe", verdict: "maybe" }),
      "agent_invocation",
    );
    insertInvocation(storage, { id: "inv_null" });
    insertInvocation(storage, { id: "inv_accept", verdict: "accept" });
    insertInvocation(storage, { id: "inv_reject", verdict: "reject" });
    assert.equal(countRows(storage, "agent_invocation"), 3);
  });

  it("attempt refuses a duplicate (run_id, attempt_no) and accepts the next number", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertAttempt(storage, { id: "attempt_dup" }),
      "attempt",
      {
        message: "UNIQUE constraint failed: attempt.run_id, attempt.attempt_no",
      },
    );
    insertAttempt(storage, { id: "attempt_second", attemptNo: 2 });
    assert.equal(countRows(storage, "attempt"), 2);
  });

  it("attempt outcome accepts the five legal values and null and refuses nonsense", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertAttempt(storage, {
          id: "attempt_nonsense",
          attemptNo: 2,
          outcome: "nonsense",
        }),
      "attempt",
    );
    ATTEMPT_OUTCOMES.forEach((outcome, index) => {
      insertAttempt(storage, {
        id: `attempt_outcome_${index}`,
        attemptNo: index + 3,
        outcome,
      });
    });
    insertAttempt(storage, {
      id: "attempt_null",
      attemptNo: ATTEMPT_OUTCOMES.length + 3,
    });
    assert.equal(countRows(storage, "attempt"), ATTEMPT_OUTCOMES.length + 2);
  });

  it("attempt refuses a provider_id with no provider row", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertAttempt(storage, {
          id: "attempt_badprovider",
          attemptNo: 2,
          providerId: "provider_missing",
        }),
      "attempt",
      { message: "FOREIGN KEY constraint failed" },
    );
  });

  it("candidate refuses an approved partial outcome with no acknowledgement", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertCandidate(storage, {
          id: "cand_partial_null",
          projectedOutcome: "partial",
          state: "approved",
        }),
      "candidate",
    );
  });

  it("candidate refuses an approved partial outcome with an explicit zero acknowledgement", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertCandidate(storage, {
          id: "cand_partial_zero",
          projectedOutcome: "partial",
          state: "approved",
          acknowledgedPartial: 0,
        }),
      "candidate",
    );
  });

  it("candidate accepts an approved partial outcome with an explicit one acknowledgement", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertCandidate(storage, {
      id: "cand_partial_one",
      projectedOutcome: "partial",
      state: "approved",
      acknowledgedPartial: 1,
    });
    assert.equal(countRows(storage, "candidate"), 1);
  });

  it("candidate accepts an approved done outcome with no acknowledgement", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertCandidate(storage, {
      id: "cand_done",
      projectedOutcome: "done",
      state: "approved",
    });
    assert.equal(countRows(storage, "candidate"), 1);
  });

  it("candidate accepts an open partial outcome with no acknowledgement", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertCandidate(storage, {
      id: "cand_open_partial",
      projectedOutcome: "partial",
      state: "open",
    });
    assert.equal(countRows(storage, "candidate"), 1);
  });

  it("candidate refuses a projected_outcome outside done and partial, and a state outside the three", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertCandidate(storage, {
          id: "cand_blocked",
          projectedOutcome: "blocked",
        }),
      "candidate",
    );
    assertRefused(
      storage,
      () => insertCandidate(storage, { id: "cand_closed", state: "closed" }),
      "candidate",
    );
  });

  it("candidate refuses a duplicate (node_id, revision)", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertCandidate(storage, { id: "cand_first" });
    assertRefused(
      storage,
      () => insertCandidate(storage, { id: "cand_second" }),
      "candidate",
      { message: "UNIQUE constraint failed" },
    );
  });

  it("check_result refuses a passed row with no commit and no manifest", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertCheck(storage, {
          id: "check_noevidence",
          result: "passed",
          commitOid: null,
        }),
      "check_result",
    );
  });

  it("check_result accepts not-applicable with no commit and no manifest", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertCheck(storage, {
      id: "check_na",
      result: "not-applicable",
      commitOid: null,
    });
    assert.equal(countRows(storage, "check_result"), 1);
  });

  it("check_result accepts a passed row with a commit_oid or a manifest_blob", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertCheck(storage, { id: "check_commit", result: "passed" });
    insertCheck(storage, {
      id: "check_manifest",
      result: "passed",
      commitOid: null,
      manifestBlob: fixtureIds.instructionBlob,
    });
    assert.equal(countRows(storage, "check_result"), 2);
  });

  it("check_result refuses a subject_kind outside the six", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertCheck(storage, { id: "check_kind", subjectKind: "nonsense" }),
      "check_result",
    );
    CANDIDATE_SUBJECT_KINDS.forEach((subjectKind, index) => {
      insertCheck(storage, { id: `check_kind_${index}`, subjectKind });
    });
    assert.equal(
      countRows(storage, "check_result"),
      CANDIDATE_SUBJECT_KINDS.length,
    );
  });

  it("check_result accepts each of the seven legal results with a commit_oid", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    CHECK_RESULTS.forEach((result, index) => {
      insertCheck(storage, { id: `check_result_${index}`, result });
    });
    assert.equal(countRows(storage, "check_result"), CHECK_RESULTS.length);
  });

  it("lease refuses a duplicate (subject_kind, subject_id) and a kind outside node and repository", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertLease(storage);
    assertRefused(storage, () => insertLease(storage), "lease", {
      message: "UNIQUE constraint failed",
    });
    assertRefused(
      storage,
      () => insertLease(storage, { subjectKind: "project" }),
      "lease",
    );
  });

  it("lease owner accepts null and the same subject_id under the other kind", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertLease(storage, { subjectKind: "node", subjectId: "lease_sub" });
    insertLease(storage, { subjectKind: "repository", subjectId: "lease_sub" });
    assert.equal(countRows(storage, "lease"), 2);
  });

  it("git_operation refuses intent rebase and accepts the four legal intents", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertGitOperation(storage, { id: "gitop_rebase", intent: "rebase" }),
      "git_operation",
    );
    ["merge", "sync", "publish", "revert"].forEach((intent, index) => {
      insertGitOperation(storage, { id: `gitop_intent_${index}`, intent });
    });
    assert.equal(countRows(storage, "git_operation"), 4);
  });

  it("git_operation refuses state pending and accepts the three legal states", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertGitOperation(storage, { id: "gitop_pending", state: "pending" }),
      "git_operation",
    );
    ["open", "complete", "discarded"].forEach((state, index) => {
      insertGitOperation(storage, { id: `gitop_state_${index}`, state });
    });
    assert.equal(countRows(storage, "git_operation"), 3);
  });

  it("git_operation outcome accepts any string", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertGitOperation(storage, { id: "gitop_outcome", outcome: "anything" });
    assert.equal(countRows(storage, "git_operation"), 1);
  });

  it("event refuses actor_kind robot and accepts human and daemon", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertEvent(storage, { id: "event_robot", actorKind: "robot" }),
      "event",
    );
    insertEvent(storage, { id: "event_daemon", actorKind: "daemon" });
    insertEvent(storage, { id: "event_human", actorKind: "human" });
    assert.equal(countRows(storage, "event"), 2);
  });
});
