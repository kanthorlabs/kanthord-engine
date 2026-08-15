import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { call } from "./cli/client.ts";
import { createTemporaryHome } from "../test/helpers/home.ts";
import type { TemporaryHome } from "../test/helpers/home.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";
import type { DaemonProcess } from "../test/helpers/daemon.ts";
import { runCli } from "../test/helpers/cli.ts";
import { reservePort } from "../test/helpers/port.ts";
import { seedRegistry } from "../test/helpers/rows.ts";

const IDENTITY_INITIATIVE = "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const IDENTITY_OBJECTIVE_ALPHA = "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV";
const IDENTITY_TASK_ALPHA_ONE = "task_01DRZ3NDEKTSV4RRFFQ69G5FAV";
const IDENTITY_TASK_ALPHA_TWO = "task_01ERZ3NDEKTSV4RRFFQ69G5FAV";
const IDENTITY_OBJECTIVE_BETA = "objective_01FQZ3NDEKTSV4RRFFQ69G5FAV";
const IDENTITY_TASK_BETA_ONE = "task_01GRZ3NDEKTSV4RRFFQ69G5FAV";

const IMPORT_ID = "import-readiness-1";

const byBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

const documents: readonly Readonly<{ path: string; content: string }>[] = [
  {
    path: "plan/i/initiative.md",
    content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV
kind: initiative
title: Two objective readiness
---
Bootstrap the frontier.
`,
  },
  {
    path: "plan/i/o--alpha/objective.md",
    content: `---
id: objective_01BQZ3NDEKTSV4RRFFQ69G5FAV
kind: objective
title: Alpha
repo: kanthord-verify
---
Deliver the first half.
`,
  },
  {
    path: "plan/i/o--alpha/01-t.md",
    content: `---
id: task_01DRZ3NDEKTSV4RRFFQ69G5FAV
kind: task
title: Alpha first
worker: tdd@1
---
Do the first alpha step.

## Acceptance criteria

- The first alpha step is done.
`,
  },
  {
    path: "plan/i/o--alpha/02-t.md",
    content: `---
id: task_01ERZ3NDEKTSV4RRFFQ69G5FAV
kind: task
title: Alpha second
depends_on:
  - task_01DRZ3NDEKTSV4RRFFQ69G5FAV
worker: tdd@1
---
Do the second alpha step.

## Acceptance criteria

- The second alpha step is done.
`,
  },
  {
    path: "plan/i/o--beta/objective.md",
    content: `---
id: objective_01FQZ3NDEKTSV4RRFFQ69G5FAV
kind: objective
title: Beta
depends_on:
  - objective_01BQZ3NDEKTSV4RRFFQ69G5FAV
repo: kanthord-verify
---
Deliver the second half.
`,
  },
  {
    path: "plan/i/o--beta/01-t.md",
    content: `---
id: task_01GRZ3NDEKTSV4RRFFQ69G5FAV
kind: task
title: Beta first
worker: tdd@1
---
Do the first beta step.

## Acceptance criteria

- The first beta step is done.
`,
  },
];

const importChoices: readonly Readonly<{ id: string; take: "submitted" }>[] = [
  { id: IDENTITY_INITIATIVE, take: "submitted" },
  { id: IDENTITY_OBJECTIVE_ALPHA, take: "submitted" },
  { id: IDENTITY_TASK_ALPHA_ONE, take: "submitted" },
  { id: IDENTITY_TASK_ALPHA_TWO, take: "submitted" },
  { id: IDENTITY_OBJECTIVE_BETA, take: "submitted" },
  { id: IDENTITY_TASK_BETA_ONE, take: "submitted" },
];

type NodeListItem = Readonly<{ id: string; state: string }>;
type EventItem = Readonly<{
  type: string;
  subjectId: string;
  actorKind: string;
  actorId: string;
  payload: unknown;
}>;

let home: TemporaryHome | undefined;
let daemon: DaemonProcess | undefined;
let port = 0;
let instanceId = "";
let validatedRevision: string | null = null;
let documentsHash = "";
let importedRevision = "";
let nodeListBody: Readonly<{ nodes: readonly NodeListItem[] }> = {
  nodes: [],
};
let objectiveAlphaBody: Readonly<{ state: string }> = { state: "" };
let objectiveBetaBody: Readonly<{ state: string }> = { state: "" };
let eventListBody: Readonly<{ events: readonly EventItem[] }> = { events: [] };
const recordedUrls: string[] = [];

describe("src/main.readiness.test", () => {
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

      const identity = JSON.parse(
        readFileSync(join(home.path, "daemon.lock.identity"), "utf8"),
      ) as { instanceId: string };
      assert.equal(typeof identity.instanceId, "string");
      instanceId = identity.instanceId;

      const clientDependencies = () => ({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "test-token",
        fetch: async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: RequestInit,
        ) => {
          recordedUrls.push(String(input));
          return await globalThis.fetch(input, init);
        },
      });

      const validated = await call(clientDependencies(), {
        operationId: "plan.validate",
        parameters: { id: "project_a" },
        body: { fromRevision: null, documents },
      });
      assert.equal(validated.status, 200);
      if (validated.ok) {
        const body = validated.body as Readonly<{
          revision: string | null;
          documentsHash: string;
        }>;
        validatedRevision = body.revision;
        documentsHash = body.documentsHash;
      }
      assert.equal(typeof documentsHash, "string");
      assert.equal(documentsHash.length > 0, true);

      const imported = await call(clientDependencies(), {
        operationId: "plan.import",
        parameters: { id: "project_a" },
        body: {
          fromRevision: validatedRevision,
          importId: IMPORT_ID,
          documents,
          choices: importChoices,
          validatedRevision,
          documentsHash,
        },
      });
      assert.equal(imported.status, 200);
      if (imported.ok) {
        const body = imported.body as Readonly<{ revision: string }>;
        importedRevision = body.revision;
      }
      assert.equal(typeof importedRevision, "string");
      assert.equal(importedRevision.length > 0, true);
      assert.notEqual(importedRevision, validatedRevision);

      const listed = await call(clientDependencies(), {
        operationId: "node.list",
      });
      assert.equal(listed.status, 200);
      if (listed.ok) {
        nodeListBody = listed.body as Readonly<{
          nodes: readonly NodeListItem[];
        }>;
      }

      const shownAlpha = await call(clientDependencies(), {
        operationId: "node.show",
        parameters: { id: IDENTITY_OBJECTIVE_ALPHA },
      });
      assert.equal(shownAlpha.status, 200);
      if (shownAlpha.ok) {
        objectiveAlphaBody = shownAlpha.body as Readonly<{ state: string }>;
      }

      const shownBeta = await call(clientDependencies(), {
        operationId: "node.show",
        parameters: { id: IDENTITY_OBJECTIVE_BETA },
      });
      assert.equal(shownBeta.status, 200);
      if (shownBeta.ok) {
        objectiveBetaBody = shownBeta.body as Readonly<{ state: string }>;
      }

      const events = await call(clientDependencies(), {
        operationId: "event.list",
        query: { limit: "200" },
      });
      assert.equal(events.status, 200);
      if (events.ok) {
        eventListBody = events.body as Readonly<{
          events: readonly EventItem[];
        }>;
      }
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

  it("an import leaves the exact ready frontier", () => {
    const frontier = nodeListBody.nodes
      .map((node) => ({ id: node.id, state: node.state }))
      .sort((left, right) => byBytes(left.id, right.id));
    assert.deepEqual(frontier, [
      { id: IDENTITY_INITIATIVE, state: "ready" },
      { id: IDENTITY_OBJECTIVE_ALPHA, state: "ready" },
      { id: IDENTITY_OBJECTIVE_BETA, state: "pending" },
      { id: IDENTITY_TASK_ALPHA_ONE, state: "ready" },
      { id: IDENTITY_TASK_ALPHA_TWO, state: "pending" },
      { id: IDENTITY_TASK_BETA_ONE, state: "ready" },
    ]);
  });

  it("a node with no dependency edge is ready at all three kinds", () => {
    const byId = new Map(nodeListBody.nodes.map((node) => [node.id, node]));
    assert.equal(byId.get(IDENTITY_INITIATIVE)?.state, "ready");
    assert.equal(byId.get(IDENTITY_OBJECTIVE_ALPHA)?.state, "ready");
    assert.equal(byId.get(IDENTITY_TASK_ALPHA_ONE)?.state, "ready");
  });

  it("node.show returns ready for the first objective and pending for the second", () => {
    assert.equal(objectiveAlphaBody.state, "ready");
    assert.equal(objectiveBetaBody.state, "pending");
  });

  it("the import appends exactly four node.ready events, in the exact order", () => {
    const readyEvents = eventListBody.events.filter(
      (event) => event.type === "node.ready",
    );
    assert.deepEqual(
      readyEvents.map((event) => event.subjectId),
      [
        IDENTITY_INITIATIVE,
        IDENTITY_OBJECTIVE_ALPHA,
        IDENTITY_TASK_ALPHA_ONE,
        IDENTITY_TASK_BETA_ONE,
      ],
    );
    assert.equal(
      eventListBody.events.filter((event) => event.type === "node.pending")
        .length,
      0,
    );
  });

  it("every node.ready event carries the daemon instance identity", () => {
    const readyEvents = eventListBody.events.filter(
      (event) => event.type === "node.ready",
    );
    for (const event of readyEvents) {
      assert.equal(event.actorKind, "daemon");
      assert.equal(event.actorId, instanceId);
    }
  });

  it("the readiness attribution differs from the import attribution", () => {
    const importEvents = eventListBody.events.filter(
      (event) =>
        event.type === "node.imported" || event.type === "plan.imported",
    );
    assert.equal(importEvents.length, 7);
    const first = importEvents[0];
    assert.ok(first !== undefined);
    assert.equal(new Set(importEvents.map((event) => event.actorId)).size, 1);
    for (const event of importEvents) {
      assert.equal(event.actorKind, "human");
    }
    const importActorId = first.actorId;
    const readyEvents = eventListBody.events.filter(
      (event) => event.type === "node.ready",
    );
    for (const event of readyEvents) {
      assert.equal(event.actorKind, "daemon");
      assert.equal(event.actorId, instanceId);
    }
    assert.notEqual(importActorId, instanceId);
  });

  it("every node.ready payload names the import that caused it", () => {
    const readyEvents = eventListBody.events.filter(
      (event) => event.type === "node.ready",
    );
    assert.equal(readyEvents.length, 4);
    for (const event of readyEvents) {
      const payload = event.payload as Readonly<{
        from: string;
        to: string;
        reason: string;
        revision: string;
        importId: string;
      }>;
      assert.equal(payload.revision, importedRevision);
      assert.equal(payload.importId, IMPORT_ID);
      assert.equal(payload.reason, "dependency-satisfied");
      assert.equal(payload.from, "pending");
      assert.equal(payload.to, "ready");
    }
  });

  it("the composition binds a real readiness", () => {
    assert.equal(
      eventListBody.events.filter((event) => event.type === "node.ready")
        .length,
      4,
    );
  });

  it("the event.list call carried limit=200 on the wire", () => {
    const last = recordedUrls[recordedUrls.length - 1];
    assert.ok(last !== undefined);
    assert.equal(
      last.endsWith("/v1/event?limit=200"),
      true,
      `expected the event.list url to carry limit=200, got ${last}`,
    );
  });

  it("the event.list page holds every event below the requested limit", () => {
    assert.equal(eventListBody.events.length < 200, true);
    assert.equal(
      eventListBody.events.filter((event) => event.type === "node.ready")
        .length,
      4,
    );
  });
});
