import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { call } from "./cli/client.ts";
import type { CallResult, ClientDependencies } from "./cli/client.ts";
import { createTemporaryHome } from "../test/helpers/home.ts";
import type { TemporaryHome } from "../test/helpers/home.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";
import type { DaemonProcess } from "../test/helpers/daemon.ts";
import { runCli } from "../test/helpers/cli.ts";
import { reservePort } from "../test/helpers/port.ts";
import { acquireLeaseOnDatabaseFile } from "../test/helpers/lease.ts";
import type { LeaseError } from "./services/lease/index.ts";

const byBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

const SEED_AT = 1700000000000;
const PROJECT_ID = "project_a";
const PROVIDER_ID = "provider_a";
const REPOSITORY_ID = "repo_a";
const REPOSITORY_NAME = "kanthord-verify";
const IMPORT_ID = "claim-journey-1";
const CONFIGURED_TOKEN = "test-token";
const TASK_TITLE = "Render the manifest";

const DOCUMENTS: readonly Readonly<{ path: string; content: string }>[] = [
  {
    path: "plan/i--01/initiative.md",
    content: `---
kind: initiative
title: Ship kanthord
---
Bootstrap the daemon.
`,
  },
  {
    path: "plan/i--01/o--02/objective.md",
    content: `---
kind: objective
title: Harden the verify CLI
repo: ${REPOSITORY_NAME}
---
Make it verifiable.
`,
  },
  {
    path: "plan/i--01/o--02/01-t.md",
    content: `---
kind: task
title: ${TASK_TITLE}
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
  },
  {
    path: "plan/i--01/o--02/02-t.md",
    content: `---
kind: task
title: ${TASK_TITLE}
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
  },
];

type ClaimBody = Readonly<{
  lease: Readonly<{
    subjectId: string;
    owner: string;
    ownerKind: string;
    fence: number;
    expiresAt: number;
  }>;
  objectiveLease: Readonly<{
    subjectId: string;
    owner: string;
    ownerKind: string;
    fence: number;
    expiresAt: number;
  }>;
  runId: string;
  objectiveRunId: string;
  attemptId: string | null;
  attemptNo: number | null;
  heartbeatIntervalMs: number;
  node: Readonly<{
    id: string;
    state: string;
    title: string;
    parentId: string | null;
  }>;
}>;

type HeartbeatBody = Readonly<{
  lease: Readonly<{ fence: number; expiresAt: number }>;
  objectiveLease: Readonly<{ fence: number; expiresAt: number }>;
  heartbeatIntervalMs: number;
}>;

let home: TemporaryHome | undefined;
let daemon: DaemonProcess | undefined;
let port = 0;
let harnessTokenA = "";
let harnessIdA = "";
let harnessTokenB = "";
let taskAId = "";
let taskBId = "";
let objectiveId = "";
let initiativeId = "";
let claimFence = 1;
let claimExpiresAt = 0;
let claimObjectiveExpiresAt = 0;
let oldTaskRunId = "";
let oldObjectiveRunId = "";
let oldAttemptId = "";
let staleFence = 1;

const client = (token: string | undefined): ClientDependencies => ({
  baseUrl: `http://127.0.0.1:${port}`,
  token,
  fetch: globalThis.fetch,
});

const bodyOf = (result: CallResult): unknown => {
  if (result.ok !== true) {
    throw new Error(`unexpected non-ok call result: ${result.code}`);
  }
  return result.body;
};

const readAll = (
  sql: string,
  params: readonly unknown[] = [],
): readonly Readonly<Record<string, unknown>>[] => {
  const database = new DatabaseSync(join(home!.path, "kanthord.db"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    return database
      .prepare(sql)
      .all(...(params as never[])) as readonly Readonly<
      Record<string, unknown>
    >[];
  } finally {
    database.close();
  }
};

const readOne = (
  sql: string,
  params: readonly unknown[] = [],
): Readonly<Record<string, unknown>> => {
  const rows = readAll(sql, params);
  assert.equal(rows.length, 1, sql);
  return rows[0]!;
};

function seedRegistryRows(): void {
  const database = new DatabaseSync(join(home!.path, "kanthord.db"));
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    database
      .prepare(
        "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        PROVIDER_ID,
        "work-anthropic",
        "llm",
        null,
        new Uint8Array([1]),
        new Uint8Array(12),
        new Uint8Array(16),
        1,
        SEED_AT,
      );
    database
      .prepare(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(PROJECT_ID, "kanthord-verify", "general@1", null, SEED_AT);
    database
      .prepare(
        "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        REPOSITORY_ID,
        REPOSITORY_NAME,
        "https://example.invalid/r.git",
        PROVIDER_ID,
        "repos/r.git",
        "main",
        "main",
        "refs/heads/main",
        1,
        "ready",
        null,
        null,
        null,
        SEED_AT,
      );
    database
      .prepare(
        "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(PROJECT_ID, "git", REPOSITORY_ID, SEED_AT);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

function expireBothLeases(taskId: string, objective: string): void {
  const database = new DatabaseSync(join(home!.path, "kanthord.db"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN IMMEDIATE");
    const expired = database
      .prepare(
        "UPDATE lease SET expires_at = 1 WHERE subject_kind = 'node' AND subject_id IN (?, ?) RETURNING subject_id",
      )
      .all(taskId, objective) as unknown as readonly { subject_id: string }[];
    database.exec("COMMIT");
    assert.deepEqual(
      [...expired].map((row) => row.subject_id).sort(byBytes),
      [taskId, objective].sort(byBytes),
    );
  } finally {
    database.close();
  }
}

describe("src/main.claim.test", () => {
  before(async () => {
    home = createTemporaryHome();
    try {
      port = await reservePort();
      const migrated = await runCli({
        args: ["db", "migrate", "--home", home.path],
      });
      assert.equal(migrated.code, 0, migrated.stderr);
      seedRegistryRows();
      const configPath = home.writeConfig({
        http: { port, allowedHosts: [`127.0.0.1:${port}`] },
      });
      daemon = launchDaemon({ configPath });
      await daemon.ready();
    } catch (error) {
      home.dispose();
      home = undefined;
      throw error;
    }
  });

  after(async () => {
    if (daemon !== undefined) {
      daemon.kill("SIGTERM");
      await daemon.exited();
    }
    if (home !== undefined) {
      home.dispose();
    }
  });

  it("plan.import creates one initiative, one objective and two sibling tasks, and actor.register creates two harnesses", async () => {
    const validated = await call(client(CONFIGURED_TOKEN), {
      operationId: "plan.validate",
      parameters: { id: PROJECT_ID },
      body: { fromRevision: null, documents: DOCUMENTS },
    });
    assert.equal(validated.status, 200, JSON.stringify(validated));
    const validation = bodyOf(validated) as Readonly<{
      documentsHash: string;
      documents: readonly Readonly<{ path: string; content: string }>[];
      revision: string | null;
      choices: readonly Readonly<{ id: string; suggested: string }>[];
    }>;

    const imported = await call(client(CONFIGURED_TOKEN), {
      operationId: "plan.import",
      parameters: { id: PROJECT_ID },
      idempotencyKey: IMPORT_ID,
      body: {
        fromRevision: null,
        importId: IMPORT_ID,
        documents: validation.documents,
        choices: validation.choices.map((entry) => ({
          id: entry.id,
          take: entry.suggested,
        })),
        validatedRevision: validation.revision,
        documentsHash: validation.documentsHash,
      },
    });
    assert.equal(imported.status, 200, JSON.stringify(imported));

    const first = await call(client(CONFIGURED_TOKEN), {
      operationId: "actor.register",
      body: { name: "harness-a" },
    });
    assert.equal(first.status, 200, JSON.stringify(first));
    harnessTokenA = (bodyOf(first) as { token: string }).token;
    harnessIdA = (bodyOf(first) as { id: string }).id;

    const second = await call(client(CONFIGURED_TOKEN), {
      operationId: "actor.register",
      body: { name: "harness-b" },
    });
    assert.equal(second.status, 200, JSON.stringify(second));
    harnessTokenB = (bodyOf(second) as { token: string }).token;
  });

  it("node.list?state=ready&kind=task returns the two tasks of the objective", async () => {
    const listed = await call(client(harnessTokenA), {
      operationId: "node.list",
      query: { state: "ready", kind: "task" },
    });
    assert.equal(listed.status, 200, JSON.stringify(listed));
    const tasks = (
      bodyOf(listed) as Readonly<{
        nodes: readonly Readonly<{
          id: string;
          kind: string;
          state: string;
          parentId: string | null;
        }>[];
      }>
    ).nodes;
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((task) => task.kind === "task"));
    assert.ok(tasks.every((task) => task.state === "ready"));
    assert.equal(tasks[0]!.parentId, tasks[1]!.parentId);
    assert.ok(tasks[0]!.parentId !== null);
    objectiveId = tasks[0]!.parentId!;
    taskAId = tasks[0]!.id;
    taskBId = tasks[1]!.id;

    const objective = await call(client(harnessTokenA), {
      operationId: "node.show",
      parameters: { id: objectiveId },
    });
    assert.equal(objective.status, 200, JSON.stringify(objective));
    initiativeId = (bodyOf(objective) as { parentId: string | null }).parentId!;
    assert.ok(initiativeId.length > 0);
  });

  it("node.claim on the first task answers 200 with external runs, attempt 1 and the full node view", async () => {
    const claimed = await call(client(harnessTokenA), {
      operationId: "node.claim",
      parameters: { id: taskAId },
      body: {},
    });
    assert.equal(claimed.status, 200, JSON.stringify(claimed));
    const body = bodyOf(claimed) as ClaimBody;

    assert.equal(body.heartbeatIntervalMs, 100000);
    assert.equal(body.attemptNo, 1);
    assert.ok(body.attemptId !== null);
    assert.equal(body.lease.subjectId, taskAId);
    assert.equal(body.lease.ownerKind, "actor");
    assert.equal(body.lease.fence, 1);
    assert.equal(body.objectiveLease.subjectId, objectiveId);
    assert.equal(body.objectiveLease.fence, 1);
    assert.equal(body.node.state, "running");
    assert.equal(body.node.title, TASK_TITLE);
    assert.equal(body.node.parentId, objectiveId);
    claimFence = body.lease.fence;
    claimExpiresAt = body.lease.expiresAt;
    claimObjectiveExpiresAt = body.objectiveLease.expiresAt;
    oldTaskRunId = body.runId;
    oldObjectiveRunId = body.objectiveRunId;
    oldAttemptId = body.attemptId;

    const taskRun = readOne(
      "SELECT kind, parent_run_id, driver, state FROM run WHERE id = ?",
      [body.runId],
    );
    assert.equal(taskRun.kind, "task");
    assert.equal(taskRun.parent_run_id, body.objectiveRunId);
    assert.equal(taskRun.driver, "external");
    assert.equal(taskRun.state, "active");
    const objectiveRun = readOne(
      "SELECT kind, parent_run_id, driver, state FROM run WHERE id = ?",
      [body.objectiveRunId],
    );
    assert.equal(objectiveRun.kind, "objective");
    assert.equal(objectiveRun.parent_run_id, null);
    assert.equal(objectiveRun.driver, "external");

    const task = await call(client(harnessTokenA), {
      operationId: "node.show",
      parameters: { id: taskAId },
    });
    assert.equal((bodyOf(task) as { state: string }).state, "running");
    const objective = await call(client(harnessTokenA), {
      operationId: "node.show",
      parameters: { id: objectiveId },
    });
    assert.equal((bodyOf(objective) as { state: string }).state, "running");
    const initiative = await call(client(harnessTokenA), {
      operationId: "node.show",
      parameters: { id: initiativeId },
    });
    assert.equal((bodyOf(initiative) as { state: string }).state, "running");
  });

  it("a second actor's claim on the sibling task is refused lease-held on the objective", async () => {
    const sibling = await call(client(harnessTokenB), {
      operationId: "node.claim",
      parameters: { id: taskBId },
      body: {},
    });
    assert.equal(sibling.status, 409, JSON.stringify(sibling));
    assert.equal(sibling.ok, false);
    assert.equal(sibling.code, "lease-held");
    const details = sibling.details as Readonly<Record<string, unknown>>;
    assert.equal(details.subject, objectiveId);
    assert.equal(details.relation, "ancestor");
    assert.equal(details.holder, harnessIdA);
    assert.equal(details.holderKind, "actor");
    assert.equal(typeof details.fence, "number");
    assert.equal(typeof details.expiresAt, "number");
  });

  it("a second actor's claim on the objective is refused lease-held on the objective itself", async () => {
    const claimed = await call(client(harnessTokenB), {
      operationId: "node.claim",
      parameters: { id: objectiveId },
      body: {},
    });
    assert.equal(claimed.status, 409, JSON.stringify(claimed));
    assert.equal(claimed.ok, false);
    assert.equal(claimed.code, "lease-held");
    const details = claimed.details as Readonly<Record<string, unknown>>;
    assert.equal(details.subject, objectiveId);
    assert.equal(details.relation, "self");
    assert.equal(details.holder, harnessIdA);
    assert.equal(details.holderKind, "actor");
    assert.equal(typeof details.fence, "number");
    assert.equal(typeof details.expiresAt, "number");
  });

  it("an EPIC-110-style objective acquisition by a daemon owner is refused lease-held", () => {
    assert.throws(
      () =>
        acquireLeaseOnDatabaseFile({
          databasePath: join(home!.path, "kanthord.db"),
          subjectKind: "node",
          subjectId: objectiveId,
          owner: "daemon_x",
          ownerKind: "daemon",
          ttlMs: 300000,
          now: SEED_AT,
        }),
      (error: unknown) =>
        error instanceof Error && (error as LeaseError).code === "lease-held",
    );
  });

  it("node.heartbeat extends expiresAt and leaves the fence unchanged", async () => {
    const heartbeated = await call(client(harnessTokenA), {
      operationId: "node.heartbeat",
      parameters: { id: taskAId },
      body: { fence: claimFence },
    });
    assert.equal(heartbeated.status, 200, JSON.stringify(heartbeated));
    const body = bodyOf(heartbeated) as HeartbeatBody;

    assert.equal(body.lease.fence, claimFence);
    assert.equal(body.objectiveLease.fence, claimFence);
    assert.ok(body.lease.expiresAt > claimExpiresAt);
    assert.ok(body.objectiveLease.expiresAt > claimObjectiveExpiresAt);
    assert.equal(body.heartbeatIntervalMs, 100000);

    const taskRow = readOne(
      "SELECT owner, owner_kind, fence, expires_at FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
      [taskAId],
    );
    assert.equal(taskRow.expires_at, body.lease.expiresAt);
    assert.equal(taskRow.fence, claimFence);
    assert.equal(taskRow.owner_kind, "actor");
    const objectiveRow = readOne(
      "SELECT owner, owner_kind, fence, expires_at FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
      [objectiveId],
    );
    assert.equal(objectiveRow.expires_at, body.objectiveLease.expiresAt);
    assert.equal(objectiveRow.fence, claimFence);
    assert.equal(objectiveRow.owner_kind, "actor");
  });

  it("an expired claim returns the task to the pool at the next claim", async () => {
    const before = readOne(
      "SELECT owner, fence, expires_at FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
      [taskAId],
    );
    assert.equal(before.fence, claimFence);

    expireBothLeases(taskAId, objectiveId);

    const claimed = await call(client(harnessTokenB), {
      operationId: "node.claim",
      parameters: { id: taskAId },
      body: {},
    });
    assert.equal(claimed.status, 200, JSON.stringify(claimed));
    const body = bodyOf(claimed) as ClaimBody;

    assert.equal(body.lease.fence, claimFence + 1);
    assert.equal(body.attemptNo, 1);
    assert.ok(body.attemptId !== null);

    const oldTaskRun = readOne("SELECT outcome FROM run WHERE id = ?", [
      oldTaskRunId,
    ]);
    assert.equal(oldTaskRun.outcome, "expired");
    const oldObjectiveRun = readOne("SELECT outcome FROM run WHERE id = ?", [
      oldObjectiveRunId,
    ]);
    assert.equal(oldObjectiveRun.outcome, "expired");
    const oldAttempt = readOne("SELECT outcome FROM attempt WHERE id = ?", [
      oldAttemptId,
    ]);
    assert.equal(oldAttempt.outcome, "cancelled");
  });

  it("the old owner's node.release is refused lease-held", async () => {
    const released = await call(client(harnessTokenA), {
      operationId: "node.release",
      parameters: { id: taskAId },
      body: { fence: claimFence },
    });
    assert.equal(released.status, 409, JSON.stringify(released));
    assert.equal(released.ok, false);
    assert.equal(released.code, "lease-held");
  });

  it("the stale fence differs from the live fence", () => {
    staleFence = claimFence;
    const live = readOne(
      "SELECT fence FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
      [taskAId],
    );
    assert.equal(live.fence, staleFence + 1);
    assert.notEqual(staleFence, live.fence);
  });

  it("the production composition root binds all three routes", async () => {
    const claimed = await call(client(harnessTokenB), {
      operationId: "node.claim",
      parameters: { id: taskBId },
      body: {},
    });
    assert.notEqual(claimed.status, 501, "node.claim answered 501");
    assert.equal(claimed.status, 200, JSON.stringify(claimed));
    const fence = (bodyOf(claimed) as ClaimBody).lease.fence;
    assert.ok(fence >= 1);

    const heartbeated = await call(client(harnessTokenB), {
      operationId: "node.heartbeat",
      parameters: { id: taskBId },
      body: { fence },
    });
    assert.notEqual(heartbeated.status, 501, "node.heartbeat answered 501");
    assert.equal(heartbeated.status, 200, JSON.stringify(heartbeated));

    const released = await call(client(harnessTokenB), {
      operationId: "node.release",
      parameters: { id: taskBId },
      body: { fence },
    });
    assert.notEqual(released.status, 501, "node.release answered 501");
    assert.equal(released.status, 200, JSON.stringify(released));
    const releaseBody = bodyOf(released) as {
      node: Readonly<{ state: string; title: string }>;
    };
    assert.equal(releaseBody.node.state, "ready");
    assert.equal(releaseBody.node.title, TASK_TITLE);
  });

  it("every request of this test was served by the production composition root", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "./main.claim.test.ts"),
      "utf8",
    );
    const importLines = source.match(/^import[^\n]*$/gm) ?? [];
    assert.equal(
      importLines.some((line) => line.includes("createTestApp")),
      false,
    );
    assert.equal(
      importLines.some((line) => line.includes("test/helpers/app.ts")),
      false,
    );
    assert.equal(
      importLines.some((line) => line.includes("main.ts")),
      false,
    );
  });
});
