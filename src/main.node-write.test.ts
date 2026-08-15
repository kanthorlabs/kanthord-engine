import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { call } from "./cli/client.ts";
import type { ClientDependencies } from "./cli/client.ts";
import { createTemporaryHome } from "../test/helpers/home.ts";
import type { TemporaryHome } from "../test/helpers/home.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";
import type { DaemonProcess } from "../test/helpers/daemon.ts";
import { runCli } from "../test/helpers/cli.ts";
import { reservePort } from "../test/helpers/port.ts";
import { fixtureIds, seedRegistry } from "../test/helpers/rows.ts";
import { canonicalDocumentsJson } from "./domain/plan-hash.ts";

const encoder = new TextEncoder();

type CallResult = Readonly<{
  ok: boolean;
  status: number;
  body: unknown;
}>;

type WriteSequence = Readonly<{
  initiativeId: string;
  objectiveId: string;
  taskId: string;
  secondTaskId: string | null;
  r1: string;
  r2: string;
  staleCreateStatus: number;
  staleCreateCode: string | undefined;
  exportAfterCreatesRevision: string | null;
  thirdCreateStatus: number;
  updateStatus: number;
  deleteStatus: number;
  deleteCompleteness: readonly Readonly<{ code: string }>[];
  exportedRevision: string | null;
  documents: readonly Readonly<{ path: string; content: string }>[];
  blobBytes: string;
  validateStatus: number;
  validateFindings: readonly Readonly<{ code: string }>[];
  importStatus: number;
  importCompleteness: readonly Readonly<{ code: string }>[];
  revisionsCallsBeforeThirdCreate: number;
}>;

async function nodeCall(
  dependencies: ClientDependencies,
  operationId: string,
  parameters: Readonly<Record<string, string>>,
  body: unknown,
): Promise<CallResult> {
  const result = await call(dependencies, { operationId, parameters, body });
  return result.ok
    ? { ok: true, status: result.status, body: result.body }
    : {
        ok: false,
        status: result.status,
        body: {
          error: { code: result.code, details: result.details },
        },
      };
}

let home: TemporaryHome | undefined;
let daemon: DaemonProcess | undefined;
let port = 0;
let sequenceA: WriteSequence | undefined;
let sequenceB: WriteSequence | undefined;
const recordedUrls: string[] = [];
let planRevisionsCalls = 0;

async function runWriteSequence(
  dependencies: ClientDependencies,
  projectId: string,
  importId: string,
  extraTask: boolean,
  captureRevisionsCalls: boolean,
): Promise<WriteSequence> {
  const nodeFor = (
    kind: "initiative" | "objective" | "task",
  ): Record<string, unknown> => {
    switch (kind) {
      case "initiative":
        return {
          kind,
          title: "Ship the release",
          instruction: "Do the initiative work.\n",
          worker: null,
          dependsOn: [],
        };
      case "objective":
        return {
          kind,
          title: "Alpha",
          parentId: "objective-parent-pending",
          repo: "kanthord-verify",
          instruction: "Do the objective work.\n",
          worker: null,
          dependsOn: [],
        };
      case "task":
        return {
          kind,
          title: "Add the health route",
          parentId: "task-parent-pending",
          instruction: "Do the task work.\n",
          acceptance: "## Acceptance criteria\n- The health route answers.\n",
          worker: null,
          dependsOn: [],
        };
    }
  };

  const createBody = (
    fromRevision: string | null,
    kind: "initiative" | "objective" | "task",
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    fromRevision,
    node: { ...nodeFor(kind), ...overrides },
  });

  const createdInitiative = await nodeCall(
    dependencies,
    "node.create",
    {
      id: projectId,
    },
    createBody(null, "initiative"),
  );
  assert.equal(createdInitiative.status, 200);
  const initiativeId = (createdInitiative.body as { id: string }).id;
  const r1 = (createdInitiative.body as { revision: string }).revision;

  const createdObjective = await nodeCall(
    dependencies,
    "node.create",
    { id: projectId },
    createBody(r1, "objective", { parentId: initiativeId }),
  );
  assert.equal(createdObjective.status, 200);
  const objectiveId = (createdObjective.body as { id: string }).id;
  const r2 = (createdObjective.body as { revision: string }).revision;

  const staleCreate = await nodeCall(
    dependencies,
    "node.create",
    { id: projectId },
    createBody(r1, "task", { parentId: objectiveId }),
  );
  assert.equal(staleCreate.status, 409);
  const staleCode = (staleCreate.body as { error: { code: string } }).error
    .code;

  const exportedAfterCreates = await call(dependencies, {
    operationId: "plan.export",
    parameters: { id: projectId },
  });
  assert.equal(exportedAfterCreates.status, 200);
  const afterCreatesRevision = exportedAfterCreates.ok
    ? (exportedAfterCreates.body as { revision: string | null }).revision
    : null;
  assert.equal(afterCreatesRevision, r2);

  const revisionsCallsBeforeThirdCreate = planRevisionsCalls;
  const createdTask = await nodeCall(
    dependencies,
    "node.create",
    { id: projectId },
    createBody(r2, "task", { parentId: objectiveId }),
  );
  assert.equal(createdTask.status, 200);
  const taskId = (createdTask.body as { id: string }).id;
  const r3 = (createdTask.body as { revision: string }).revision;

  let secondTaskId: string | null = null;
  if (extraTask) {
    const createdSecond = await nodeCall(
      dependencies,
      "node.create",
      { id: projectId },
      createBody(r3, "task", {
        title: "Add the status route",
        parentId: objectiveId,
      }),
    );
    assert.equal(createdSecond.status, 200);
    secondTaskId = (createdSecond.body as { id: string }).id;
  }

  const updated = await nodeCall(
    dependencies,
    "node.update",
    {
      id: taskId,
    },
    {
      fromRevision: r3,
      node: {
        kind: "task",
        title: "Add the health route and the status route",
        parentId: objectiveId,
        instruction: "Do the task work.\n",
        acceptance: "## Acceptance criteria\n- The health route answers.\n",
        worker: null,
        dependsOn: [],
      },
    },
  );
  assert.equal(updated.status, 200);
  const r4 = (updated.body as { revision: string }).revision;

  const deletedId = secondTaskId ?? taskId;
  const deleted = await nodeCall(
    dependencies,
    "node.delete",
    {
      id: deletedId,
    },
    { fromRevision: r4 },
  );
  assert.equal(deleted.status, 200);
  const deleteCompleteness = (
    deleted.body as {
      completeness: readonly Readonly<{ code: string }>[];
    }
  ).completeness;
  const r5 = (deleted.body as { revision: string }).revision;

  const exported = await call(dependencies, {
    operationId: "plan.export",
    parameters: { id: projectId },
  });
  assert.equal(exported.status, 200);
  assert.ok(exported.ok);
  const exportedBody = exported.body as {
    revision: string | null;
    documents: readonly Readonly<{ path: string; content: string }>[];
  };
  assert.equal(exportedBody.revision, r5);

  const revisions = await call(dependencies, {
    operationId: "plan.revisions",
    parameters: { id: projectId },
  });
  assert.equal(revisions.status, 200);
  assert.ok(revisions.ok);
  const revisionsBody = revisions.body as {
    revisions: readonly {
      id: string;
      origin: string;
      acceptedBlob: string;
    }[];
  };
  assert.equal(revisionsBody.revisions.length > 0, true);
  assert.equal(revisionsBody.revisions[0]?.id, r5);
  assert.equal(revisionsBody.revisions[0]?.origin, "node-write");
  const acceptedBlob = revisionsBody.revisions[0]?.acceptedBlob;
  assert.equal(typeof acceptedBlob, "string");

  const blob = await call(dependencies, {
    operationId: "blob.show",
    parameters: { hash: acceptedBlob! },
  });
  assert.equal(blob.status, 200);
  assert.ok(blob.ok);
  const blobBytes = blob.body as string;
  assert.equal(typeof blobBytes, "string");

  const validated = await call(dependencies, {
    operationId: "plan.validate",
    parameters: { id: projectId },
    body: {
      fromRevision: r5,
      documents: exportedBody.documents,
    },
  });
  assert.equal(validated.status, 200);
  assert.ok(validated.ok);
  const validatedBody = validated.body as {
    findings: readonly Readonly<{ code: string }>[];
    documentsHash: string;
  };

  const imported = await nodeCall(
    dependencies,
    "plan.import",
    {
      id: projectId,
    },
    {
      fromRevision: r5,
      importId,
      documents: exportedBody.documents,
      choices: [initiativeId, objectiveId, taskId]
        .filter((id) => id !== deletedId)
        .map((id) => ({ id, take: "submitted" })),
      validatedRevision: r5,
      documentsHash: validatedBody.documentsHash,
    },
  );
  assert.equal(imported.status, 200);
  const importCompleteness = (
    imported.body as {
      completeness: readonly Readonly<{ code: string }>[];
    }
  ).completeness;

  return {
    initiativeId,
    objectiveId,
    taskId,
    secondTaskId,
    r1,
    r2,
    staleCreateStatus: staleCreate.status,
    staleCreateCode: staleCode,
    exportAfterCreatesRevision: afterCreatesRevision,
    thirdCreateStatus: createdTask.status,
    updateStatus: updated.status,
    deleteStatus: deleted.status,
    deleteCompleteness,
    exportedRevision: exportedBody.revision,
    documents: exportedBody.documents,
    blobBytes,
    validateStatus: validated.status,
    validateFindings: validatedBody.findings,
    importStatus: imported.status,
    importCompleteness,
    revisionsCallsBeforeThirdCreate: captureRevisionsCalls
      ? revisionsCallsBeforeThirdCreate
      : -1,
  };
}

describe("src/main.node-write.test", () => {
  before(async () => {
    home = createTemporaryHome();
    try {
      port = await reservePort();
      const configPath = home.writeConfig({
        http: { port, allowedHosts: [`127.0.0.1:${port}`] },
      });
      const migrated = await runCli({
        args: ["db", "migrate", "--home", home.path],
      });
      assert.equal(migrated.code, 0, migrated.stderr);

      const database = new DatabaseSync(join(home.path, "kanthord.db"));
      try {
        const adapter = {
          run: (sql: string, p: readonly unknown[] = []) => {
            database.prepare(sql).run(...(p as never[]));
          },
          get: (sql: string, p: readonly unknown[] = []) =>
            database.prepare(sql).get(...(p as never[])),
          all: (sql: string, p: readonly unknown[] = []) =>
            database.prepare(sql).all(...(p as never[])),
        };
        database.exec("BEGIN");
        try {
          seedRegistry(adapter);
          adapter.run(
            "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
            ["project_b", "kanthord-verify-b", "general@1", null, 1],
          );
          adapter.run(
            "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)",
            ["project_b", "git", fixtureIds.repository, 1],
          );
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      } finally {
        database.close();
      }

      daemon = launchDaemon({ configPath });
      await daemon.ready();

      const clientDependencies = (): ClientDependencies => ({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "test-token",
        fetch: async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: RequestInit,
        ) => {
          const url = String(input);
          recordedUrls.push(url);
          if (url.includes("/plan/revision")) {
            planRevisionsCalls += 1;
          }
          return await globalThis.fetch(input, init);
        },
      });

      sequenceA = await runWriteSequence(
        clientDependencies(),
        "project_a",
        "imp-node-write-a",
        true,
        true,
      );
      sequenceB = await runWriteSequence(
        clientDependencies(),
        "project_b",
        "imp-node-write-b",
        false,
        false,
      );
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

  it("two creates chain the guard token without a plan.revisions call", () => {
    assert.ok(sequenceA !== undefined);
    assert.equal(sequenceA.r1.length > 0, true);
    assert.equal(sequenceA.exportAfterCreatesRevision, sequenceA.r2);
    assert.equal(sequenceA.staleCreateStatus, 409);
    assert.equal(sequenceA.staleCreateCode, "stale-revision");
    assert.equal(sequenceA.thirdCreateStatus, 200);
    assert.equal(
      sequenceA.revisionsCallsBeforeThirdCreate,
      0,
      "the guard token chain must not read plan.revisions",
    );
  });

  it("the export bytes equal the fetched accepted blob bytes on the complete graph", () => {
    assert.ok(sequenceA !== undefined);
    const bytes = encoder.encode(canonicalDocumentsJson(sequenceA.documents));
    assert.equal(
      Buffer.compare(Buffer.from(sequenceA.blobBytes, "utf8"), bytes),
      0,
    );
  });

  it("plan.validate answers 200 with no finding on the complete graph", () => {
    assert.ok(sequenceA !== undefined);
    assert.equal(sequenceA.validateStatus, 200);
    assert.deepEqual(sequenceA.validateFindings, []);
  });

  it("plan.import at the returned revision answers 200 on the complete graph", () => {
    assert.ok(sequenceA !== undefined);
    assert.equal(sequenceA.importStatus, 200);
    assert.deepEqual(sequenceA.importCompleteness, []);
  });

  it("a delete that leaves the graph incomplete still commits and re-imports", () => {
    assert.ok(sequenceB !== undefined);
    assert.equal(sequenceB.deleteStatus, 200);
    assert.deepEqual(
      sequenceB.deleteCompleteness.map((finding) => finding.code),
      ["objective-without-task"],
    );
    assert.equal(sequenceB.validateStatus, 200);
    assert.deepEqual(
      sequenceB.validateFindings.map((finding) => finding.code),
      ["objective-without-task"],
    );
    assert.equal(sequenceB.importStatus, 200);
    assert.deepEqual(
      sequenceB.importCompleteness.map((finding) => finding.code),
      ["objective-without-task"],
    );
  });

  it("the sequence reaches a blob whose bytes the export reproduces on the incomplete graph", () => {
    assert.ok(sequenceB !== undefined);
    const bytes = encoder.encode(canonicalDocumentsJson(sequenceB.documents));
    assert.equal(
      Buffer.compare(Buffer.from(sequenceB.blobBytes, "utf8"), bytes),
      0,
    );
  });

  it("the daemon logged no internal error while serving the two sequences", () => {
    assert.ok(daemon !== undefined);
    const stderr = daemon.stderr();
    assert.equal(stderr.includes("internal-error"), false, stderr);
    assert.ok(recordedUrls.length > 0);
  });
});
