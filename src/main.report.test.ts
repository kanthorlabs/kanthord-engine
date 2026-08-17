import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { call } from "./cli/client.ts";
import { nodeUnblockResponse } from "./http/contract/outcome.ts";
import type { CallResult, ClientDependencies } from "./cli/client.ts";
import { bootstrapActorId } from "./domain/actor.ts";
import { createTemporaryHome } from "../test/helpers/home.ts";
import type { TemporaryHome } from "../test/helpers/home.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";
import type { DaemonProcess } from "../test/helpers/daemon.ts";
import { runCli } from "../test/helpers/cli.ts";
import { reservePort } from "../test/helpers/port.ts";
import type { Transaction } from "./services/storage/index.ts";
import {
  seedNodeBlockReason,
  seedNodeState,
  seedRegistry,
} from "../test/helpers/rows.ts";

const CONFIGURED_TOKEN = "test-token";
const IMPORT_ID = "outcome-report-import";
const OBJECT_ID_ONE = "a".repeat(40);
const OBJECT_ID_TWO = "b".repeat(40);

const INITIATIVE_ALPHA = "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OBJECTIVE_ALPHA = "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV";
const TASK_ALPHA_ONE = "task_01DRZ3NDEKTSV4RRFFQ69G5FAV";
const TASK_ALPHA_TWO = "task_01ERZ3NDEKTSV4RRFFQ69G5FAV";
const OBJECTIVE_BETA = "objective_01GRZ3NDEKTSV4RRFFQ69G5FAV";
const TASK_BETA = "task_01HRZ3NDEKTSV4RRFFQ69G5FAV";
const INITIATIVE_GAMMA = "initiative_01JQZ3NDEKTSV4RRFFQ69G5FAV";
const OBJECTIVE_GAMMA = "objective_01KQZ3NDEKTSV4RRFFQ69G5FAV";
const TASK_GAMMA = "task_01MQZ3NDEKTSV4RRFFQ69G5FAV";

type StoredRow = Readonly<Record<string, unknown>>;

type Actor = Readonly<{
  id: string;
  token: string;
}>;

type ClaimBody = Readonly<{
  lease: Readonly<{ fence: number; expiresAt: number; owner: string }>;
  objectiveLease: Readonly<{
    fence: number;
    expiresAt: number;
    owner: string;
  }>;
  runId: string;
  objectiveRunId: string;
  attemptId: string | null;
  attemptNo: number | null;
  node: Readonly<{ id: string; state: string }>;
}>;

type NodeReportBody = Readonly<{
  nodeId: string;
  kind: string;
  state: string;
  blockReason: string | null;
  attemptId: string | null;
  attemptNo: number | null;
  attemptsRemaining: number | null;
  objectId: string | null;
  objectiveState: string | null;
  objectiveProjection: string | null;
}>;

type NodeShowBody = Readonly<{
  state: string;
  attestedObjectId: string | null;
  projection: string | null;
}>;

type ValidationBody = Readonly<{
  documents: readonly Readonly<{ path: string; content: string }>[];
  revision: string | null;
  documentsHash: string;
  choices: readonly Readonly<{ id: string; suggested: string }>[];
}>;

type EventRow = Readonly<{
  id: string;
  type: string;
  actor_kind: string;
  actor_id: string;
  payload_json: string;
}>;

type Snapshot = readonly Readonly<{
  name: string;
  rows: readonly StoredRow[];
}>[];

type Fixture = Readonly<{
  home: TemporaryHome;
  port: number;
  configPath: string;
  humanToken: string;
  harness: Actor;
  instanceId: string;
  client(token?: string): ClientDependencies;
  restart(): Promise<void>;
  cleanup(): Promise<void>;
}>;

const documents: readonly Readonly<{ path: string; content: string }>[] = [
  {
    path: "plan/a/initiative.md",
    content: `---
id: ${INITIATIVE_ALPHA}
kind: initiative
title: Alpha initiative
---
Complete alpha.
`,
  },
  {
    path: "plan/a/o--alpha/objective.md",
    content: `---
id: ${OBJECTIVE_ALPHA}
kind: objective
title: Alpha objective
repo: kanthord-verify
---
Complete alpha objective.
`,
  },
  {
    path: "plan/a/o--alpha/01-task.md",
    content: `---
id: ${TASK_ALPHA_ONE}
kind: task
title: Alpha first task
worker: tdd@1
---
Complete alpha first.

## Acceptance criteria

- Alpha first is complete.
`,
  },
  {
    path: "plan/a/o--alpha/02-task.md",
    content: `---
id: ${TASK_ALPHA_TWO}
kind: task
title: Alpha second task
depends_on:
  - ${TASK_ALPHA_ONE}
worker: tdd@1
---
Complete alpha second.

## Acceptance criteria

- Alpha second is complete.
`,
  },
  {
    path: "plan/a/o--beta/objective.md",
    content: `---
id: ${OBJECTIVE_BETA}
kind: objective
title: Beta objective
depends_on:
  - ${OBJECTIVE_ALPHA}
repo: kanthord-verify
---
Complete beta objective.
`,
  },
  {
    path: "plan/a/o--beta/01-task.md",
    content: `---
id: ${TASK_BETA}
kind: task
title: Beta task
worker: tdd@1
---
Complete beta task.

## Acceptance criteria

- Beta is complete.
`,
  },
  {
    path: "plan/g/initiative.md",
    content: `---
id: ${INITIATIVE_GAMMA}
kind: initiative
title: Gamma initiative
---
Complete gamma.
`,
  },
  {
    path: "plan/g/o--gamma/objective.md",
    content: `---
id: ${OBJECTIVE_GAMMA}
kind: objective
title: Gamma objective
repo: kanthord-verify
---
Complete gamma objective.
`,
  },
  {
    path: "plan/g/o--gamma/01-task.md",
    content: `---
id: ${TASK_GAMMA}
kind: task
title: Gamma task
worker: tdd@1
---
Complete gamma.

## Acceptance criteria

- Gamma is complete.
`,
  },
];

function clientFor(
  port: number,
  token: string | undefined,
): ClientDependencies {
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    fetch: globalThis.fetch,
  };
}

function bodyOf(result: CallResult): unknown {
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.message}`);
  }
  return result.body;
}

function assertStatus(result: CallResult, status: number): void {
  assert.equal(result.status, status, JSON.stringify(result));
}

function assertRefusal(result: CallResult, status: number, code: string): void {
  assertStatus(result, status);
  if (result.ok) {
    throw new Error(`expected ${code}, received success`);
  }
  assert.equal(result.code, code);
}

function seedRegistryDatabase(homePath: string): void {
  const database = new DatabaseSync(join(homePath, "kanthord.db"));
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("BEGIN");
    try {
      seedRegistry({
        run(sql: string, parameters: readonly unknown[] = []): void {
          database.prepare(sql).run(...(parameters as never[]));
        },
        get(sql: string, parameters: readonly unknown[] = []): unknown {
          return database.prepare(sql).get(...(parameters as never[]));
        },
        all(
          sql: string,
          parameters: readonly unknown[] = [],
        ): readonly unknown[] {
          return database
            .prepare(sql)
            .all(...(parameters as never[])) as readonly unknown[];
        },
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function withDatabase<T>(
  homePath: string,
  work: (database: DatabaseSync) => T,
): T {
  const database = new DatabaseSync(join(homePath, "kanthord.db"));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    return work(database);
  } finally {
    database.close();
  }
}

function rowsFrom(
  database: DatabaseSync,
  sql: string,
  parameters: readonly unknown[] = [],
): readonly StoredRow[] {
  return database
    .prepare(sql)
    .all(...(parameters as never[])) as readonly StoredRow[];
}

function oneRow(
  database: DatabaseSync,
  sql: string,
  parameters: readonly unknown[] = [],
): StoredRow {
  const rows = rowsFrom(database, sql, parameters);
  assert.equal(rows.length, 1, sql);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`no row for ${sql}`);
  }
  return row;
}

function databaseSnapshot(homePath: string): Snapshot {
  return withDatabase(homePath, (database) => {
    const tables = rowsFrom(
      database,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    return tables.map((table) => {
      const name = String(table.name);
      const quoted = `"${name.replaceAll('"', '""')}"`;
      return {
        name,
        rows: rowsFrom(database, `SELECT * FROM ${quoted} ORDER BY rowid`),
      };
    });
  });
}

function nodeRow(homePath: string, nodeId: string): StoredRow {
  return withDatabase(homePath, (database) =>
    oneRow(database, "SELECT state, block_reason FROM node WHERE id = ?", [
      nodeId,
    ]),
  );
}

function seedBlockedNode(homePath: string, nodeId: string): void {
  withDatabase(homePath, (database) => {
    const transaction: Transaction = {
      run(sql: string, parameters: readonly unknown[] = []): void {
        database.prepare(sql).run(...(parameters as never[]));
      },
      get(sql: string, parameters: readonly unknown[] = []): unknown {
        return database.prepare(sql).get(...(parameters as never[]));
      },
      all(
        sql: string,
        parameters: readonly unknown[] = [],
      ): readonly unknown[] {
        return database
          .prepare(sql)
          .all(...(parameters as never[])) as readonly unknown[];
      },
    };
    seedNodeState(transaction, nodeId, "blocked");
    seedNodeBlockReason(transaction, nodeId, "attempt-limit");
  });
}

function runRow(homePath: string, runId: string): StoredRow {
  return withDatabase(homePath, (database) =>
    oneRow(
      database,
      "SELECT state, outcome, head_oid, ended_at FROM run WHERE id = ?",
      [runId],
    ),
  );
}

function objectiveLeaseRow(homePath: string, objectiveId: string): StoredRow {
  return withDatabase(homePath, (database) =>
    oneRow(
      database,
      "SELECT owner, owner_kind, fence, expires_at FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
      [objectiveId],
    ),
  );
}

function taskLeaseRow(homePath: string, taskId: string): StoredRow {
  return withDatabase(homePath, (database) =>
    oneRow(
      database,
      "SELECT owner, owner_kind, fence, expires_at FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
      [taskId],
    ),
  );
}

function attemptCount(homePath: string, runId: string): number {
  return withDatabase(homePath, (database) => {
    const row = oneRow(
      database,
      "SELECT COUNT(*) AS count FROM attempt WHERE run_id = ?",
      [runId],
    );
    return Number(row.count);
  });
}

function eventRows(homePath: string, subjectId: string): readonly EventRow[] {
  return withDatabase(
    homePath,
    (database) =>
      rowsFrom(
        database,
        "SELECT id, type, actor_kind, actor_id, payload_json FROM event WHERE subject_id = ? ORDER BY id ASC",
        [subjectId],
      ) as readonly EventRow[],
  );
}

function expireLease(homePath: string, subjectId: string): void {
  withDatabase(homePath, (database) => {
    database
      .prepare(
        "UPDATE lease SET expires_at = 1 WHERE subject_kind = 'node' AND subject_id = ?",
      )
      .run(subjectId);
  });
}

function daemonInstanceId(homePath: string): string {
  return (
    JSON.parse(
      readFileSync(join(homePath, "daemon.lock.identity"), "utf8"),
    ) as Readonly<{ instanceId: string }>
  ).instanceId;
}

async function importPlan(client: ClientDependencies): Promise<void> {
  const validated = await call(client, {
    operationId: "plan.validate",
    parameters: { id: "project_a" },
    body: { fromRevision: null, documents },
  });
  assertStatus(validated, 200);
  const validation = bodyOf(validated) as ValidationBody;
  const imported = await call(client, {
    operationId: "plan.import",
    parameters: { id: "project_a" },
    idempotencyKey: IMPORT_ID,
    body: {
      fromRevision: null,
      importId: IMPORT_ID,
      documents: validation.documents,
      choices: validation.choices.map((choice) => ({
        id: choice.id,
        take: choice.suggested,
      })),
      validatedRevision: validation.revision,
      documentsHash: validation.documentsHash,
    },
  });
  assertStatus(imported, 200);
}

async function registerHarness(
  client: ClientDependencies,
  name: string,
): Promise<Actor> {
  const result = await call(client, {
    operationId: "actor.register",
    body: { name },
  });
  assertStatus(result, 200);
  const body = bodyOf(result) as Readonly<{ id: string; token: string }>;
  return { id: body.id, token: body.token };
}

async function createFixture(
  options: Readonly<{ attemptLimit?: number }> = {},
): Promise<Fixture> {
  const home = createTemporaryHome();
  let port = 0;
  let configPath = "";
  let current: DaemonProcess | undefined;
  const stop = async (): Promise<void> => {
    const daemon = current;
    if (daemon === undefined) {
      return;
    }
    daemon.kill("SIGTERM");
    await daemon.exited();
    current = undefined;
  };
  try {
    port = await reservePort();
    configPath = home.writeConfig({
      attemptLimit: options.attemptLimit ?? 3,
      http: {
        port,
        allowedHosts: [`127.0.0.1:${port}`],
      },
    });
    const migrated = await runCli({
      args: ["db", "migrate", "--home", home.path],
    });
    assert.equal(migrated.code, 0, migrated.stderr);
    seedRegistryDatabase(home.path);
    current = launchDaemon({ configPath });
    await current.ready();
    const client = clientFor(port, CONFIGURED_TOKEN);
    await importPlan(client);
    const harness = await registerHarness(client, "harness-a");
    const instanceId = daemonInstanceId(home.path);
    const restart = async (): Promise<void> => {
      await stop();
      current = launchDaemon({ configPath });
      await current.ready();
    };
    return {
      home,
      port,
      configPath,
      humanToken: CONFIGURED_TOKEN,
      harness,
      instanceId,
      client(token = CONFIGURED_TOKEN) {
        return clientFor(port, token);
      },
      restart,
      cleanup: async () => {
        await stop();
        home.dispose();
      },
    };
  } catch (error) {
    await stop();
    home.dispose();
    throw error;
  }
}

async function claim(
  fixture: Fixture,
  actor: Actor,
  nodeId: string,
): Promise<ClaimBody> {
  const result = await call(fixture.client(actor.token), {
    operationId: "node.claim",
    parameters: { id: nodeId },
    body: {},
  });
  assertStatus(result, 200);
  return bodyOf(result) as ClaimBody;
}

async function report(
  fixture: Fixture,
  token: string,
  nodeId: string,
  body: unknown,
  idempotencyKey?: string,
): Promise<CallResult> {
  return call(fixture.client(token), {
    operationId: "node.report",
    parameters: { id: nodeId },
    body,
    idempotencyKey,
  });
}

async function nodeShow(
  fixture: Fixture,
  nodeId: string,
): Promise<NodeShowBody> {
  const result = await call(fixture.client(), {
    operationId: "node.show",
    parameters: { id: nodeId },
  });
  assertStatus(result, 200);
  return bodyOf(result) as NodeShowBody;
}

async function acceptTask(
  fixture: Fixture,
  actor: Actor,
  taskId: string,
  objectId: string,
): Promise<Readonly<{ claim: ClaimBody; report: NodeReportBody }>> {
  const claimed = await claim(fixture, actor, taskId);
  const result = await report(fixture, actor.token, taskId, {
    report: "accepted",
    fence: claimed.lease.fence,
    objectId,
  });
  assertStatus(result, 200);
  return { claim: claimed, report: bodyOf(result) as NodeReportBody };
}

async function rejectTask(
  fixture: Fixture,
  actor: Actor,
  taskId: string,
  fence: number,
): Promise<NodeReportBody> {
  const result = await report(fixture, actor.token, taskId, {
    report: "rejected",
    fence,
    reason: "the harness rejected this attempt",
  });
  assertStatus(result, 200);
  return bodyOf(result) as NodeReportBody;
}

async function blockTask(
  fixture: Fixture,
  actor: Actor,
  taskId: string,
): Promise<Readonly<{ endedRunId: string; objectiveFence: number }>> {
  let endedRunId = "";
  let objectiveFence = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const claimed = await claim(fixture, actor, taskId);
    objectiveFence = claimed.objectiveLease.fence;
    endedRunId = claimed.runId;
    await rejectTask(fixture, actor, taskId, claimed.lease.fence);
  }
  return { endedRunId, objectiveFence };
}

describe("src/main.report.test", () => {
  it("the whole loop reaches done through the real composition root", async () => {
    const fixture = await createFixture();
    try {
      const first = await claim(fixture, fixture.harness, TASK_ALPHA_ONE);
      const firstReport = await acceptTask(
        fixture,
        fixture.harness,
        TASK_ALPHA_ONE,
        OBJECT_ID_ONE,
      );
      assert.equal(firstReport.claim.runId, first.runId);
      assert.equal(firstReport.report.state, "done");
      assert.equal(firstReport.report.objectiveProjection, null);
      assert.equal(nodeRow(fixture.home.path, TASK_ALPHA_ONE).state, "done");

      const second = await claim(fixture, fixture.harness, TASK_ALPHA_TWO);
      const secondReport = await acceptTask(
        fixture,
        fixture.harness,
        TASK_ALPHA_TWO,
        OBJECT_ID_TWO,
      );
      assert.equal(secondReport.claim.runId, second.runId);
      assert.equal(secondReport.report.state, "done");
      assert.equal(secondReport.report.objectiveState, "running");
      assert.equal(secondReport.report.objectiveProjection, "done");

      const heldObjectiveLease = objectiveLeaseRow(
        fixture.home.path,
        OBJECTIVE_ALPHA,
      );
      assert.equal(heldObjectiveLease.owner, fixture.harness.id);
      assert.equal(heldObjectiveLease.fence, first.objectiveLease.fence);

      const beforeAttestation = await nodeShow(fixture, OBJECTIVE_ALPHA);
      assert.equal(beforeAttestation.projection, "done");
      assert.equal(beforeAttestation.attestedObjectId, null);

      const attested = await report(
        fixture,
        fixture.harness.token,
        OBJECTIVE_ALPHA,
        {
          report: "attested",
          fence: first.objectiveLease.fence,
          objectId: OBJECT_ID_TWO,
        },
      );
      assertStatus(attested, 200);
      const attestedBody = bodyOf(attested) as NodeReportBody;
      assert.equal(attestedBody.state, "awaiting_approval");

      const activeObjectiveRun = runRow(
        fixture.home.path,
        first.objectiveRunId,
      );
      assert.equal(activeObjectiveRun.state, "active");
      assert.equal(activeObjectiveRun.head_oid, OBJECT_ID_TWO);

      const afterAttestation = await nodeShow(fixture, OBJECTIVE_ALPHA);
      assert.equal(afterAttestation.attestedObjectId, OBJECT_ID_TWO);

      const closed = await report(
        fixture,
        fixture.humanToken,
        OBJECTIVE_ALPHA,
        { report: "closed", acknowledgePartial: false },
      );
      assertStatus(closed, 200);
      assert.equal((bodyOf(closed) as NodeReportBody).state, "done");

      const endedObjectiveRun = runRow(fixture.home.path, first.objectiveRunId);
      assert.equal(endedObjectiveRun.state, "ended");
      assert.equal(endedObjectiveRun.outcome, "done");
      assert.equal(
        nodeRow(fixture.home.path, INITIATIVE_ALPHA).state,
        "running",
      );
      assert.equal(nodeRow(fixture.home.path, OBJECTIVE_BETA).state, "ready");

      const betaTask = await acceptTask(
        fixture,
        fixture.harness,
        TASK_BETA,
        OBJECT_ID_ONE,
      );
      assert.equal(betaTask.report.objectiveProjection, "done");
      const betaAttested = await report(
        fixture,
        fixture.harness.token,
        OBJECTIVE_BETA,
        {
          report: "attested",
          fence: betaTask.claim.objectiveLease.fence,
          objectId: OBJECT_ID_ONE,
        },
      );
      assertStatus(betaAttested, 200);
      const betaClosed = await report(
        fixture,
        fixture.humanToken,
        OBJECTIVE_BETA,
        { report: "closed", acknowledgePartial: false },
      );
      assertStatus(betaClosed, 200);
      assert.equal((bodyOf(betaClosed) as NodeReportBody).state, "done");
      assert.equal(nodeRow(fixture.home.path, OBJECTIVE_BETA).state, "done");
      assert.equal(nodeRow(fixture.home.path, INITIATIVE_ALPHA).state, "done");
    } finally {
      await fixture.cleanup();
    }
  });

  it("two sequential sibling tasks stay with one harness", async () => {
    const fixture = await createFixture();
    try {
      const first = await acceptTask(
        fixture,
        fixture.harness,
        TASK_ALPHA_ONE,
        OBJECT_ID_ONE,
      );
      const secondHarness = await registerHarness(
        fixture.client(fixture.humanToken),
        "harness-b",
      );
      const refused = await call(fixture.client(secondHarness.token), {
        operationId: "node.claim",
        parameters: { id: TASK_ALPHA_TWO },
        body: {},
      });
      assertRefusal(refused, 409, "lease-held");

      const second = await acceptTask(
        fixture,
        fixture.harness,
        TASK_ALPHA_TWO,
        OBJECT_ID_TWO,
      );
      assert.equal(second.claim.objectiveRunId, first.claim.objectiveRunId);
      const attested = await report(
        fixture,
        fixture.harness.token,
        OBJECTIVE_ALPHA,
        {
          report: "attested",
          fence: first.claim.objectiveLease.fence,
          objectId: OBJECT_ID_TWO,
        },
      );
      assertStatus(attested, 200);
    } finally {
      await fixture.cleanup();
    }
  });

  it("the active run survives a daemon restart and adoption is the only recovery", async () => {
    const fixture = await createFixture();
    try {
      const first = await claim(fixture, fixture.harness, TASK_ALPHA_ONE);
      await rejectTask(
        fixture,
        fixture.harness,
        TASK_ALPHA_ONE,
        first.lease.fence,
      );
      const beforeRestart = taskLeaseRow(fixture.home.path, TASK_ALPHA_ONE);
      assert.equal(beforeRestart.owner, null);
      assert.equal(beforeRestart.expires_at, null);
      const objectiveBeforeRestart = objectiveLeaseRow(
        fixture.home.path,
        OBJECTIVE_ALPHA,
      );
      assert.equal(objectiveBeforeRestart.owner, fixture.harness.id);
      assert.equal(objectiveBeforeRestart.fence, first.objectiveLease.fence);

      await fixture.restart();
      const adopted = await claim(fixture, fixture.harness, TASK_ALPHA_ONE);
      assert.equal(adopted.runId, first.runId);
      assert.equal(adopted.attemptNo, 2);
      assert.notEqual(adopted.lease.fence, first.lease.fence);
      const objectiveAfterRestart = objectiveLeaseRow(
        fixture.home.path,
        OBJECTIVE_ALPHA,
      );
      assert.equal(objectiveAfterRestart.owner, fixture.harness.id);
      assert.equal(objectiveAfterRestart.fence, first.objectiveLease.fence);
      assert.equal(
        taskLeaseRow(fixture.home.path, TASK_ALPHA_ONE).owner,
        fixture.harness.id,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("an objective abandoned after a task report is recovered by expiry", async () => {
    const fixture = await createFixture();
    try {
      const first = await acceptTask(
        fixture,
        fixture.harness,
        TASK_ALPHA_ONE,
        OBJECT_ID_ONE,
      );
      const second = await acceptTask(
        fixture,
        fixture.harness,
        TASK_ALPHA_TWO,
        OBJECT_ID_TWO,
      );
      assert.equal(second.report.objectiveProjection, "done");
      const secondHarness = await registerHarness(
        fixture.client(fixture.humanToken),
        "harness-b",
      );
      expireLease(fixture.home.path, OBJECTIVE_ALPHA);

      const unrelated = await claim(fixture, secondHarness, TASK_GAMMA);
      assert.equal(unrelated.node.state, "running");
      const recoveredLease = objectiveLeaseRow(
        fixture.home.path,
        OBJECTIVE_ALPHA,
      );
      assert.equal(recoveredLease.owner, null);
      assert.equal(
        nodeRow(fixture.home.path, OBJECTIVE_ALPHA).state,
        "running",
      );
      assert.equal(first.claim.objectiveRunId.length > 0, true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("an expired lease is swept before reclaim, and stale owner and fence reports are refused", async () => {
    const fixture = await createFixture();
    try {
      const first = await claim(fixture, fixture.harness, TASK_ALPHA_ONE);
      const secondHarness = await registerHarness(
        fixture.client(fixture.humanToken),
        "harness-b",
      );
      expireLease(fixture.home.path, TASK_ALPHA_ONE);
      expireLease(fixture.home.path, OBJECTIVE_ALPHA);

      const reclaimed = await claim(fixture, secondHarness, TASK_ALPHA_ONE);
      assert.equal(reclaimed.node.state, "running");
      assert.equal(reclaimed.lease.owner, secondHarness.id);
      assert.equal(reclaimed.lease.fence, first.lease.fence + 1);
      assert.equal(runRow(fixture.home.path, first.runId).outcome, "expired");
      assert.equal(
        runRow(fixture.home.path, first.objectiveRunId).outcome,
        "expired",
      );
      assert.ok(
        eventRows(fixture.home.path, TASK_ALPHA_ONE).some(
          (event) => event.type === "recovery.leaseRecovered",
        ),
      );
      assert.ok(
        eventRows(fixture.home.path, OBJECTIVE_ALPHA).some(
          (event) => event.type === "recovery.leaseRecovered",
        ),
      );

      const beforeStaleOwner = databaseSnapshot(fixture.home.path);
      const staleOwner = await report(
        fixture,
        fixture.harness.token,
        TASK_ALPHA_ONE,
        {
          report: "accepted",
          fence: reclaimed.lease.fence,
          objectId: OBJECT_ID_ONE,
        },
      );
      assertRefusal(staleOwner, 409, "lease-held");
      assert.deepEqual(databaseSnapshot(fixture.home.path), beforeStaleOwner);

      const beforeStaleFence = databaseSnapshot(fixture.home.path);
      const staleFence = await report(
        fixture,
        secondHarness.token,
        TASK_ALPHA_ONE,
        {
          report: "accepted",
          fence: first.lease.fence,
          objectId: OBJECT_ID_ONE,
        },
      );
      assertRefusal(staleFence, 409, "lease-held");
      assert.deepEqual(databaseSnapshot(fixture.home.path), beforeStaleFence);

      const accepted = await report(
        fixture,
        secondHarness.token,
        TASK_ALPHA_ONE,
        {
          report: "accepted",
          fence: reclaimed.lease.fence,
          objectId: OBJECT_ID_ONE,
        },
      );
      assertStatus(accepted, 200);
    } finally {
      await fixture.cleanup();
    }
  });

  it("a replayed report under a repeated Idempotency-Key closes no second attempt", async () => {
    const fixture = await createFixture();
    try {
      const claimed = await claim(fixture, fixture.harness, TASK_ALPHA_ONE);
      const body = {
        report: "accepted",
        fence: claimed.lease.fence,
        objectId: OBJECT_ID_ONE,
      } as const;
      const first = await report(
        fixture,
        fixture.harness.token,
        TASK_ALPHA_ONE,
        body,
        "report-replay",
      );
      assertStatus(first, 200);
      const countAfterFirst = attemptCount(fixture.home.path, claimed.runId);
      const nodeAfterFirst = nodeRow(fixture.home.path, TASK_ALPHA_ONE);

      const replay = await report(
        fixture,
        fixture.harness.token,
        TASK_ALPHA_ONE,
        body,
        "report-replay",
      );
      assertStatus(replay, 200);
      assert.deepEqual(bodyOf(replay), bodyOf(first));
      assert.equal(
        attemptCount(fixture.home.path, claimed.runId),
        countAfterFirst,
      );
      assert.deepEqual(
        nodeRow(fixture.home.path, TASK_ALPHA_ONE),
        nodeAfterFirst,
      );

      const withoutKey = await report(
        fixture,
        fixture.harness.token,
        TASK_ALPHA_ONE,
        body,
      );
      assertRefusal(withoutKey, 409, "illegal-transition");
    } finally {
      await fixture.cleanup();
    }
  });

  it("a report by a human token and a close by a harness token are each 403 actor-forbidden", async () => {
    const fixture = await createFixture();
    try {
      const claimed = await claim(fixture, fixture.harness, TASK_ALPHA_ONE);
      const beforeReport = databaseSnapshot(fixture.home.path);
      const humanReport = await report(
        fixture,
        fixture.humanToken,
        TASK_ALPHA_ONE,
        {
          report: "accepted",
          fence: claimed.lease.fence,
          objectId: OBJECT_ID_ONE,
        },
      );
      assertRefusal(humanReport, 403, "actor-forbidden");
      assert.deepEqual(databaseSnapshot(fixture.home.path), beforeReport);

      await acceptTask(fixture, fixture.harness, TASK_ALPHA_ONE, OBJECT_ID_ONE);
      const second = await acceptTask(
        fixture,
        fixture.harness,
        TASK_ALPHA_TWO,
        OBJECT_ID_TWO,
      );
      const attested = await report(
        fixture,
        fixture.harness.token,
        OBJECTIVE_ALPHA,
        {
          report: "attested",
          fence: claimed.objectiveLease.fence,
          objectId: OBJECT_ID_TWO,
        },
      );
      assertStatus(attested, 200);
      assert.equal(second.report.objectiveProjection, "done");

      const beforeClose = databaseSnapshot(fixture.home.path);
      const harnessClose = await report(
        fixture,
        fixture.harness.token,
        OBJECTIVE_ALPHA,
        { report: "closed", acknowledgePartial: false },
      );
      assertRefusal(harnessClose, 403, "actor-forbidden");
      assert.deepEqual(databaseSnapshot(fixture.home.path), beforeClose);
    } finally {
      await fixture.cleanup();
    }
  });

  it("a task blocked at the attempt limit runs again after an unblock", async () => {
    const fixture = await createFixture({ attemptLimit: 3 });
    try {
      const blocked = await blockTask(fixture, fixture.harness, TASK_ALPHA_ONE);
      assert.equal(nodeRow(fixture.home.path, TASK_ALPHA_ONE).state, "blocked");
      assert.equal(
        nodeRow(fixture.home.path, TASK_ALPHA_ONE).block_reason,
        "attempt-limit",
      );
      assert.equal(
        runRow(fixture.home.path, blocked.endedRunId).state,
        "ended",
      );
      assert.equal(
        runRow(fixture.home.path, blocked.endedRunId).outcome,
        "blocked",
      );

      const eventsBeforeUnblock = eventRows(fixture.home.path, TASK_ALPHA_ONE);
      const unblocked = await call(fixture.client(fixture.humanToken), {
        operationId: "node.unblock",
        parameters: { id: TASK_ALPHA_ONE },
      });
      assertStatus(unblocked, 200);
      assert.equal(
        nodeUnblockResponse.safeParse(bodyOf(unblocked)).success,
        true,
        "the node.unblock body does not parse through nodeUnblockResponse",
      );
      const unblockedBody = bodyOf(unblocked) as Readonly<{
        node: Readonly<{ id: string; state: string }>;
      }>;
      assert.equal(unblockedBody.node.id, TASK_ALPHA_ONE);
      assert.equal(unblockedBody.node.state, "ready");
      assert.equal(nodeRow(fixture.home.path, TASK_ALPHA_ONE).state, "ready");
      assert.equal(
        nodeRow(fixture.home.path, TASK_ALPHA_ONE).block_reason,
        null,
      );

      const taskEvents = eventRows(fixture.home.path, TASK_ALPHA_ONE);
      const recoveryEvents = taskEvents.slice(eventsBeforeUnblock.length);
      assert.deepEqual(
        recoveryEvents.map((event) => event.type),
        ["node.unblocked", "node.ready"],
      );
      const unblockedEvent = recoveryEvents[0];
      const readyEvent = recoveryEvents[1];
      assert.ok(unblockedEvent !== undefined);
      assert.ok(readyEvent !== undefined);
      assert.equal(unblockedEvent.actor_kind, "human");
      assert.equal(unblockedEvent.actor_id, bootstrapActorId);
      assert.equal(readyEvent.actor_kind, "daemon");
      assert.equal(readyEvent.actor_id, fixture.instanceId);
      assert.deepEqual(JSON.parse(unblockedEvent.payload_json), {
        from: "blocked",
        to: "pending",
        clearedReason: "attempt-limit",
      });

      const rerun = await claim(fixture, fixture.harness, TASK_ALPHA_ONE);
      assert.notEqual(rerun.runId, blocked.endedRunId);
      assert.equal(rerun.attemptNo, 1);
      await report(fixture, fixture.harness.token, TASK_ALPHA_ONE, {
        report: "accepted",
        fence: rerun.lease.fence,
        objectId: OBJECT_ID_ONE,
      }).then((result) => assertStatus(result, 200));
      const secondTask = await acceptTask(
        fixture,
        fixture.harness,
        TASK_ALPHA_TWO,
        OBJECT_ID_TWO,
      );
      assert.equal(secondTask.report.objectiveProjection, "done");
      const attested = await report(
        fixture,
        fixture.harness.token,
        OBJECTIVE_ALPHA,
        {
          report: "attested",
          fence: blocked.objectiveFence,
          objectId: OBJECT_ID_TWO,
        },
      );
      assertStatus(attested, 200);
      const closed = await report(
        fixture,
        fixture.humanToken,
        OBJECTIVE_ALPHA,
        { report: "closed", acknowledgePartial: false },
      );
      assertStatus(closed, 200);
      assert.equal((bodyOf(closed) as NodeReportBody).state, "done");
    } finally {
      await fixture.cleanup();
    }
  });

  it("an unblocked task with an unsatisfied dependency stays unclaimable", async () => {
    const fixture = await createFixture();
    try {
      await claim(fixture, fixture.harness, TASK_ALPHA_ONE);
      seedBlockedNode(fixture.home.path, TASK_ALPHA_TWO);

      const unblocked = await call(fixture.client(fixture.humanToken), {
        operationId: "node.unblock",
        parameters: { id: TASK_ALPHA_TWO },
      });
      assertStatus(unblocked, 200);
      const unblockedBody = bodyOf(unblocked) as Readonly<{
        node: Readonly<{ id: string; state: string }>;
      }>;
      assert.equal(unblockedBody.node.id, TASK_ALPHA_TWO);
      assert.equal(unblockedBody.node.state, "pending");
      const pendingRow = nodeRow(fixture.home.path, TASK_ALPHA_TWO);
      assert.equal(pendingRow.state, "pending");
      assert.equal(pendingRow.block_reason, null);

      const beforeClaim = databaseSnapshot(fixture.home.path);
      const refused = await call(fixture.client(fixture.harness.token), {
        operationId: "node.claim",
        parameters: { id: TASK_ALPHA_TWO },
        body: {},
      });
      assertRefusal(refused, 409, "illegal-transition");
      if (refused.ok) {
        throw new Error("expected claim refusal");
      }
      assert.deepEqual(refused.details, {
        refusal: "node-state",
        state: "pending",
        admitted: ["ready", "running"],
      });
      assert.deepEqual(databaseSnapshot(fixture.home.path), beforeClaim);
    } finally {
      await fixture.cleanup();
    }
  });

  it("an unblock by a harness token is 403 actor-forbidden", async () => {
    const fixture = await createFixture({ attemptLimit: 3 });
    try {
      await blockTask(fixture, fixture.harness, TASK_ALPHA_ONE);
      const before = databaseSnapshot(fixture.home.path);
      const refused = await call(fixture.client(fixture.harness.token), {
        operationId: "node.unblock",
        parameters: { id: TASK_ALPHA_ONE },
      });
      assertRefusal(refused, 403, "actor-forbidden");
      assert.deepEqual(databaseSnapshot(fixture.home.path), before);
    } finally {
      await fixture.cleanup();
    }
  });
});
