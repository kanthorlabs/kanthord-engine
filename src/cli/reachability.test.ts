import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import {
  createCommandRecorder,
  type RecordedRequest,
} from "../../test/helpers/command-recorder.ts";
import type { PlanDirectoryDependencies } from "./plan/directory.ts";
import { commandPaths, declaredCommands } from "./inventory.ts";

type Row = Readonly<{
  path: readonly string[];
  argv: readonly string[];
  operationIds: readonly string[];
  effect?: "migrate" | "planWrite" | "serve" | "writeFile";
}>;

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HASH = `sha256:${"0".repeat(64)}`;
const ACTOR_ID = `actor_${ULID}`;
const PROJECT_ID = `project_${ULID}`;
const PROVIDER_ID = `provider_${ULID}`;
const REPOSITORY_ID = `repo_${ULID}`;
const OBJECTIVE_ID = `objective_${ULID}`;
const TASK_ID = `task_${ULID}`;
const RUN_ID = `run_${ULID}`;
const ATTEMPT_ID = `attempt_${ULID}`;
const REVISION_ID = `revision_${ULID}`;
const EVENT_ID = `event_${ULID}`;
const ACTOR_TOKEN = `${ACTOR_ID}.${"a".repeat(43)}`;

const actor = {
  id: ACTOR_ID,
  kind: "human",
  name: "recorder",
  registeredBy: null,
  createdAt: 1722800000000,
  revokedAt: null,
  revokedBy: null,
};

const provider = {
  id: PROVIDER_ID,
  name: "gh",
  kind: "git",
  projection: {
    transport: "http-basic",
    forge: "github",
    username: "recorder",
  },
  setDefaultAt: null,
  updatedAt: 1722800000000,
};

const repository = {
  id: REPOSITORY_ID,
  name: "atlas",
  remoteUrl: "https://example.test/atlas.git",
  credential: { id: PROVIDER_ID, name: "gh" },
  branch: "main",
  landingRef: "refs/heads/main",
  trackingRef: "refs/remotes/origin/main",
  publishRef: "refs/heads/main",
  publishOnApproval: true,
  state: "ready",
  landingOid: null,
  trackingOid: null,
  fetchedUpstreamOid: null,
  divergedLandingOid: null,
  divergedUpstreamOid: null,
  updatedAt: 1722800000000,
};

const project = {
  id: PROJECT_ID,
  name: "atlas",
  repositories: [REPOSITORY_ID],
  updatedAt: 1722800000000,
};

const node = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  kind: "task",
  title: "record the command",
  state: "ready",
  blockReason: null,
  discardReason: null,
  parentId: OBJECTIVE_ID,
  dependencies: [],
  instructionBlob: HASH,
  acceptanceBlob: null,
  instruction: "",
  acceptance: "",
  worker: null,
  assignment: null,
  deliverable: null,
  verify: null,
  repositoryId: REPOSITORY_ID,
  repo: "atlas",
  revision: REVISION_ID,
  updatedAt: 1722800000000,
  attestedObjectId: null,
  projection: null,
};

const lease = {
  subjectId: TASK_ID,
  owner: ACTOR_ID,
  ownerKind: "actor",
  fence: 1,
  expiresAt: 1722800300000,
};

const objectiveLease = {
  subjectId: OBJECTIVE_ID,
  owner: ACTOR_ID,
  ownerKind: "actor",
  fence: 1,
  expiresAt: 1722800300000,
};

const document = { path: "initiative.md", content: "# initiative\n" };

const CONVERT_EPIC = `# EPIC 040 — Recorder conversion

## Goal

Record a local conversion.

## Stories

1. First recorder story
2. Second recorder story
`;

const CONVERT_FIRST_STORY = `# Story 1 — First recorder story

## Change

Create the first recorder node.

## Constraints

Use the first recorder constraint.

## Verify

Check the first recorder result.
`;

const CONVERT_SECOND_STORY = `# Story 2 — Second recorder story

## Change

Create the second recorder node.

## Constraints

Use the second recorder constraint.

## Verify

Check the second recorder result.
`;

const CONVERT_EPIC_RELATIVE = "fixtures/epics/040-recorder.md";
const CONVERT_EPIC_PATH = `/tmp/kanthord-command-recorder/${CONVERT_EPIC_RELATIVE}`;
const CONVERT_STORY_ROOT =
  "/tmp/kanthord-command-recorder/fixtures/stories/040-recorder";

const convertFileSystem = (): PlanDirectoryDependencies => {
  const files = new Map<string, string>([
    [CONVERT_EPIC_PATH, CONVERT_EPIC],
    [`${CONVERT_STORY_ROOT}/01-first.md`, CONVERT_FIRST_STORY],
    [`${CONVERT_STORY_ROOT}/02-second.md`, CONVERT_SECOND_STORY],
  ]);
  const absent = (path: string): Error & { code: string } =>
    Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const readDirectory = (path: string): readonly string[] => {
    if (path === CONVERT_STORY_ROOT) {
      return ["02-second.md", "index.md", "01-first.md"];
    }
    const prefix = `${path}/`;
    const names = new Map<string, boolean>();
    for (const filePath of files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      if (rest.length === 0) continue;
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      names.set(name, slash !== -1 || (names.get(name) ?? false));
    }
    if (names.size === 0) throw absent(path);
    return [...names.entries()].map(([name, directory]) =>
      directory ? `${name}/` : name,
    );
  };
  return {
    readDirectory,
    readFile: (path) => {
      const content = files.get(path);
      if (content === undefined) throw absent(path);
      return content;
    },
    writeFile: (path, content) => {
      files.set(path, content);
    },
    makeDirectory: () => undefined,
    removeFile: (path) => {
      files.delete(path);
    },
  };
};

const responseFor = (request: RecordedRequest): unknown => {
  switch (request.operationId) {
    case "actor.list":
      return { actors: [] };
    case "actor.register":
    case "actor.rotate":
      return { ...actor, token: ACTOR_TOKEN };
    case "actor.revoke":
    case "actor.show":
      return actor;
    case "provider.register":
    case "provider.show":
      return provider;
    case "provider.list":
      return { providers: [provider] };
    case "repository.inspect":
      return {
        defaultBranch: "main",
        branches: ["main"],
        credential: { reachable: true, refusal: null },
        hostKey: null,
        access: { read: { allowed: true, refusal: null }, write: null },
      };
    case "repository.register":
    case "repository.show":
      return repository;
    case "repository.list":
      return { repositories: [repository] };
    case "project.create":
    case "project.repositories":
    case "project.show":
      return project;
    case "project.nodes":
      return { nodes: [] };
    case "project.graph":
      return {
        attributes: { projectId: PROJECT_ID, revision: null },
        options: { allowSelfLoops: false, multi: false, type: "directed" },
        nodes: [],
        edges: [],
      };
    case "project.list":
      return { projects: [] };
    case "system.db":
      return { migrations: [] };
    case "system.status":
      return {
        version: "test",
        bind: "127.0.0.1:7421",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "ok",
        dependencies: [],
        nodes: [],
        repositories: [],
        leases: [],
      };
    case "event.list":
      return { events: [] };
    case "plan.export":
      return { revision: null, documents: [] };
    case "plan.revisions":
      return { revisions: [] };
    case "plan.validate":
      return {
        findings: [],
        documents: [document],
        documentsHash: HASH,
        revision: null,
        choices: [],
      };
    case "plan.import":
      return {
        revision: REVISION_ID,
        documents: [document],
        absent: [],
        completeness: [],
      };
    case "node.list":
      return { nodes: [] };
    case "node.show":
      return node;
    case "node.create":
      return { revision: REVISION_ID, id: TASK_ID, completeness: [] };
    case "node.update":
      return { revision: REVISION_ID, completeness: [] };
    case "node.delete":
      return { revision: REVISION_ID, deleted: [TASK_ID], completeness: [] };
    case "node.claim":
      return {
        lease,
        objectiveLease,
        runId: RUN_ID,
        objectiveRunId: RUN_ID,
        attemptId: ATTEMPT_ID,
        attemptNo: 1,
        heartbeatIntervalMs: 1000,
        node: { ...node, state: "running" },
      };
    case "node.heartbeat":
      return { lease, objectiveLease, heartbeatIntervalMs: 1000 };
    case "node.release":
      return { node };
    case "node.report":
      return {
        nodeId: TASK_ID,
        kind: "task",
        state: "done",
        blockReason: null,
        attemptId: ATTEMPT_ID,
        attemptNo: 1,
        attemptsRemaining: 1,
        objectId: "a".repeat(40),
        objectiveState: "running",
        objectiveProjection: null,
      };
    case "node.unblock":
      return { node };
    case "run.start":
      return {};
    case "system.health":
      return { status: "ok", dependencies: [] };
    default:
      return {};
  }
};

const fs = {
  readDirectory: () => ["initiative.md"],
  readFile: () => document.content,
  writeFile: () => undefined,
  makeDirectory: () => undefined,
  removeFile: () => undefined,
};

const rows: readonly Row[] = [
  {
    path: ["actor", "list"],
    argv: ["actor", "list"],
    operationIds: ["actor.list"],
  },
  {
    path: ["actor", "register"],
    argv: [
      "actor",
      "register",
      "--name",
      "harness",
      "--output-token-file",
      "/tmp/token",
    ],
    operationIds: ["actor.register"],
  },
  {
    path: ["actor", "revoke"],
    argv: ["actor", "revoke", "--id", ACTOR_ID],
    operationIds: ["actor.revoke"],
  },
  {
    path: ["actor", "rotate"],
    argv: [
      "actor",
      "rotate",
      "--id",
      ACTOR_ID,
      "--output-token-file",
      "/tmp/token-rotate",
    ],
    operationIds: ["actor.rotate"],
  },
  {
    path: ["actor", "show"],
    argv: ["actor", "show", "--id", ACTOR_ID],
    operationIds: ["actor.show"],
  },
  {
    path: ["config", "generate"],
    argv: ["config", "generate"],
    operationIds: [],
    effect: "writeFile",
  },
  {
    path: ["credential", "register"],
    argv: [
      "credential",
      "register",
      "--name",
      "gh",
      "--kind",
      "git",
      "--transport",
      "http-basic",
      "--forge",
      "github",
      "--username",
      "recorder",
      "--input-token-file",
      "/tmp/credential-token",
    ],
    operationIds: ["provider.register"],
  },
  {
    path: ["db", "migrate"],
    argv: ["db", "migrate"],
    operationIds: [],
    effect: "migrate",
  },
  {
    path: ["db", "status"],
    argv: ["db", "status"],
    operationIds: ["system.db"],
  },
  {
    path: ["event", "list"],
    argv: ["event", "list"],
    operationIds: ["event.list"],
  },
  {
    path: ["node", "attest"],
    argv: [
      "node",
      "attest",
      "--id",
      OBJECTIVE_ID,
      "--fence",
      "1",
      "--object-id",
      "a".repeat(40),
    ],
    operationIds: ["node.report"],
  },
  {
    path: ["node", "claim"],
    argv: ["node", "claim", "--id", TASK_ID],
    operationIds: ["node.claim"],
  },
  {
    path: ["node", "close"],
    argv: ["node", "close", "--id", OBJECTIVE_ID],
    operationIds: ["node.report"],
  },
  {
    path: ["node", "create"],
    argv: [
      "node",
      "create",
      "--project",
      PROJECT_ID,
      "--kind",
      "task",
      "--title",
      "new task",
      "--parent",
      OBJECTIVE_ID,
    ],
    operationIds: ["plan.revisions", "node.create"],
  },
  {
    path: ["node", "delete"],
    argv: ["node", "delete", "--id", TASK_ID],
    operationIds: ["node.show", "plan.revisions", "node.delete"],
  },
  {
    path: ["node", "heartbeat"],
    argv: ["node", "heartbeat", "--id", TASK_ID, "--fence", "1"],
    operationIds: ["node.heartbeat"],
  },
  {
    path: ["node", "list"],
    argv: ["node", "list"],
    operationIds: ["node.list"],
  },
  {
    path: ["node", "release"],
    argv: ["node", "release", "--id", TASK_ID, "--fence", "1"],
    operationIds: ["node.release"],
  },
  {
    path: ["node", "report"],
    argv: [
      "node",
      "report",
      "--id",
      TASK_ID,
      "--outcome",
      "accepted",
      "--fence",
      "1",
      "--object-id",
      "a".repeat(40),
    ],
    operationIds: ["node.report"],
  },
  {
    path: ["node", "show"],
    argv: ["node", "show", "--id", TASK_ID],
    operationIds: ["node.show"],
  },
  {
    path: ["node", "unblock"],
    argv: ["node", "unblock", "--id", TASK_ID],
    operationIds: ["node.unblock"],
  },
  {
    path: ["node", "update"],
    argv: [
      "node",
      "update",
      "--id",
      TASK_ID,
      "--depends-on",
      `task_${"02ARZ3NDEKTSV4RRFFQ69G5FAV"}`,
    ],
    operationIds: ["node.show", "plan.revisions", "node.update"],
  },
  {
    path: ["plan", "convert"],
    argv: [
      "plan",
      "convert",
      "--from",
      CONVERT_EPIC_RELATIVE,
      "--repo",
      "atlas",
      "--to",
      "converted",
    ],
    operationIds: [],
    effect: "planWrite",
  },
  {
    path: ["plan", "export"],
    argv: ["plan", "export", "--project", PROJECT_ID],
    operationIds: ["plan.export"],
  },
  {
    path: ["plan", "import"],
    argv: [
      "plan",
      "import",
      "--project",
      PROJECT_ID,
      "--directory",
      "/tmp/plan",
      "--yes",
    ],
    operationIds: ["plan.revisions", "plan.validate", "plan.import"],
  },
  {
    path: ["project", "create"],
    argv: ["project", "create", "--name", "atlas"],
    operationIds: ["project.create"],
  },
  {
    path: ["project", "graph"],
    argv: ["project", "graph", "--id", PROJECT_ID],
    operationIds: ["project.graph"],
  },
  {
    path: ["project", "list"],
    argv: ["project", "list"],
    operationIds: ["project.list"],
  },
  {
    path: ["project", "node"],
    argv: ["project", "node", "--id", PROJECT_ID],
    operationIds: ["project.nodes"],
  },
  {
    path: ["project", "repository"],
    argv: [
      "project",
      "repository",
      "--id",
      PROJECT_ID,
      "--repository",
      "atlas",
    ],
    operationIds: ["repository.list", "project.repositories"],
  },
  {
    path: ["project", "show"],
    argv: ["project", "show", "--id", PROJECT_ID],
    operationIds: ["project.show"],
  },
  {
    path: ["repository", "register"],
    argv: [
      "repository",
      "register",
      "--name",
      "atlas",
      "--url",
      "https://example.test/atlas.git",
      "--credential",
      "gh",
      "--branch",
      "main",
    ],
    operationIds: [
      "provider.list",
      "repository.inspect",
      "repository.register",
    ],
  },
  {
    path: ["repository", "show"],
    argv: ["repository", "show", "--id", REPOSITORY_ID],
    operationIds: ["repository.show"],
  },
  {
    path: ["run"],
    argv: ["run", "--project", PROJECT_ID],
    operationIds: ["run.start"],
  },
  { path: ["serve"], argv: ["serve"], operationIds: [], effect: "serve" },
  { path: ["status"], argv: ["status"], operationIds: ["system.status"] },
];

const recorderOptions = {
  respond: responseFor,
  readFile: () => "credential-secret",
  fs,
};

const rowName = (row: Row): string => row.path.join(" ");

const declaredFor = (row: Row) =>
  declaredCommands.find((entry) => entry.path.join(" ") === rowName(row));

const assertReachable = (row: Row, actual: readonly string[]): void => {
  assert.deepEqual(actual, row.operationIds, `command ${rowName(row)}`);
};

describe("src/cli/reachability.test", () => {
  it("holds one argument row for every declared command", () => {
    assert.deepEqual(rows.map(rowName).sort(), [...commandPaths()].sort());
  });

  it("every leaf issues exactly the operation ids its inventory row declares, in order", async () => {
    for (const row of rows) {
      const declared = declaredFor(row);
      assert.ok(declared, `missing declared command ${rowName(row)}`);
      assert.deepEqual(
        row.operationIds,
        declared.operationIds,
        `row differs from inventory for ${rowName(row)}`,
      );
      const recorder = createCommandRecorder(
        row.effect === "planWrite"
          ? { ...recorderOptions, fs: convertFileSystem() }
          : recorderOptions,
      );
      await recorder.run(row.argv);
      assertReachable(row, recorder.operationIds());
    }
  });

  it("plan import issues plan.revisions, plan.validate, plan.import in that order", async () => {
    const row = rows.find((candidate) => rowName(candidate) === "plan import");
    assert.ok(row);
    const recorder = createCommandRecorder(recorderOptions);
    await recorder.run(row.argv);
    assert.deepEqual(recorder.operationIds(), [
      "plan.revisions",
      "plan.validate",
      "plan.import",
    ]);
  });

  it("repository register issues provider.list, repository.inspect, repository.register in that order", async () => {
    const row = rows.find(
      (candidate) => rowName(candidate) === "repository register",
    );
    assert.ok(row);
    const recorder = createCommandRecorder(recorderOptions);
    await recorder.run(row.argv);
    assert.deepEqual(recorder.operationIds(), [
      "provider.list",
      "repository.inspect",
      "repository.register",
    ]);
  });

  it("node update issues node.show, plan.revisions, node.update in that order", async () => {
    const row = rows.find((candidate) => rowName(candidate) === "node update");
    assert.ok(row);
    const recorder = createCommandRecorder(recorderOptions);
    await recorder.run(row.argv);
    assert.deepEqual(recorder.operationIds(), [
      "node.show",
      "plan.revisions",
      "node.update",
    ]);
  });

  it("event list issues event.list alone", async () => {
    const row = rows.find((candidate) => rowName(candidate) === "event list");
    assert.ok(row);
    const recorder = createCommandRecorder(recorderOptions);
    await recorder.run(row.argv);
    assert.deepEqual(recorder.operationIds(), ["event.list"]);
  });

  it("local commands issue no request and record their own effect once", async () => {
    for (const effect of [
      "writeFile",
      "migrate",
      "serve",
      "planWrite",
    ] as const) {
      const row = rows.find((candidate) => candidate.effect === effect);
      assert.ok(row);
      const recorder = createCommandRecorder(
        effect === "planWrite"
          ? { ...recorderOptions, fs: convertFileSystem() }
          : recorderOptions,
      );
      await recorder.run(row.argv);
      assert.deepEqual(recorder.operationIds(), [], rowName(row));
      if (effect === "planWrite") {
        assert.equal(recorder.planWriteFileCalls().length, 5, rowName(row));
      } else {
        assert.equal(
          effect === "writeFile"
            ? recorder.writeFileCalls().length
            : effect === "migrate"
              ? recorder.migrateCalls()
              : recorder.serveCalls(),
          1,
          rowName(row),
        );
      }
    }
  });

  it("a leaf whose action is not registered fails and names the command path", async () => {
    const row = rows.find((candidate) => rowName(candidate) === "node delete");
    assert.ok(row);
    const program = new Command();
    program.command("node").command("delete").option("--id <id>");
    await program.parseAsync(row.argv, { from: "user" });

    assert.throws(
      () => assertReachable(row, []),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /node delete/);
        return true;
      },
    );
  });
});
