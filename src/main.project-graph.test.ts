import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { call } from "./cli/client.ts";
import type { ClientDependencies } from "./cli/client.ts";
import { createTemporaryHome } from "../test/helpers/home.ts";
import type { TemporaryHome } from "../test/helpers/home.ts";
import { launchDaemon } from "../test/helpers/daemon.ts";
import type { DaemonProcess } from "../test/helpers/daemon.ts";
import { reservePort } from "../test/helpers/port.ts";
import { runCli } from "../test/helpers/cli.ts";
import { seedRegistry } from "../test/helpers/rows.ts";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

describe("src/main.project-graph.test", () => {
  let home: TemporaryHome | undefined;
  let daemon: DaemonProcess | undefined;
  let port = 0;
  let dependencies: ClientDependencies | undefined;

  before(async () => {
    home = createTemporaryHome();
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

    dependencies = {
      baseUrl: `http://127.0.0.1:${port}`,
      token: "test-token",
      fetch: globalThis.fetch,
    };
  });

  after(async () => {
    if (daemon) {
      daemon.kill();
      await daemon.exited();
    }
    if (home) {
      home.dispose();
    }
  });

  const planA: readonly { path: string; content: string }[] = [
    {
      path: "plan/ia/initiative.md",
      content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV
kind: initiative
title: Project A Initiative
---
Bootstrap the project.
`,
    },
    {
      path: "plan/ia/oa--alpha/objective.md",
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
      path: "plan/ia/oa--alpha/01-t.md",
      content: `---
id: task_01DRZ3NDEKTSV4RRFFQ69G5FAV
kind: task
title: Task A1
worker: tdd@1
---
Do the first alpha step.

## Acceptance criteria

- The first alpha step is done.
`,
    },
    {
      path: "plan/ia/oa--alpha/02-t.md",
      content: `---
id: task_01ERZ3NDEKTSV4RRFFQ69G5FAV
kind: task
title: Task A2
depends_on:
  - task_01DRZ3NDEKTSV4RRFFQ69G5FAV
worker: tdd@1
---
Do the second alpha step.

## Acceptance criteria

- The second alpha step is done.
`,
    },
  ];

  const planB: readonly { path: string; content: string }[] = [
    {
      path: "plan/ib/initiative.md",
      content: `---
id: initiative_01FQZ3NDEKTSV4RRFFQ69G5FAV
kind: initiative
title: Project B Initiative
---
Bootstrap the project.
`,
    },
    {
      path: "plan/ib/ob--beta/objective.md",
      content: `---
id: objective_01GRZ3NDEKTSV4RRFFQ69G5FAV
kind: objective
title: Beta
repo: kanthord-verify
---
Deliver the second half.
`,
    },
    {
      path: "plan/ib/ob--beta/01-t.md",
      content: `---
id: task_01HRZ3NDEKTSV4RRFFQ69G5FAV
kind: task
title: Task B1
worker: tdd@1
---
Do the first beta step.

## Acceptance criteria

- The first beta step is done.
`,
    },
    {
      path: "plan/ib/ob--beta/02-t.md",
      content: `---
id: task_01JRZ3NDEKTSV4RRFFQ69G5FAV
kind: task
title: Task B2
depends_on:
  - task_01HRZ3NDEKTSV4RRFFQ69G5FAV
worker: tdd@1
---
Do the second beta step.

## Acceptance criteria

- The second beta step is done.
`,
    },
  ];

  const importPlan = async (
    projectName: string,
    documents: readonly { path: string; content: string }[],
  ) => {
    const createResult = await call(dependencies!, {
      operationId: "project.create",
      body: { name: projectName },
    });
    assert.equal(createResult.status, 200);
    assert.ok(createResult.ok);
    const projectId = (createResult.body as { id: string }).id;

    const bindResult = await call(dependencies!, {
      operationId: "project.repositories",
      parameters: { id: projectId },
      body: { repositories: ["repo_a"] },
    });
    if (bindResult.status !== 200) {
      console.error(
        "Project repositories bind failed:",
        bindResult.status,
        bindResult.ok
          ? bindResult.body
          : {
              code: bindResult.code,
              message: bindResult.message,
              details: bindResult.details,
            },
      );
    }
    assert.equal(bindResult.status, 200);
    assert.ok(bindResult.ok);

    const validated = await call(dependencies!, {
      operationId: "plan.validate",
      parameters: { id: projectId },
      body: { fromRevision: null, documents },
    });
    assert.ok(
      validated.ok,
      `Plan validate failed: ${validated.status} ${JSON.stringify(validated.ok ? validated.body : { code: validated.code, message: validated.message, details: validated.details }, null, 2)}`,
    );
    const validatedBody = validated.body as {
      revision: string | null;
      documentsHash: string;
      choices: readonly { id: string; suggested: "submitted" | "database" }[];
    };

    const choices = validatedBody.choices.map((c) => ({
      id: c.id,
      take: c.suggested,
    }));

    const imported = await call(dependencies!, {
      operationId: "plan.import",
      parameters: { id: projectId },
      body: {
        fromRevision: validatedBody.revision,
        importId: "imp_01JRZ3NDEKTSV4RRFFQ69G5FAW",
        documents,
        choices,
        validatedRevision: validatedBody.revision,
        documentsHash: validatedBody.documentsHash,
      },
    });
    assert.equal(imported.status, 200);
    assert.ok(imported.ok);

    return projectId;
  };

  const getProjectNodes = async (projectId: string) => {
    return call(dependencies!, {
      operationId: "project.nodes",
      parameters: { id: projectId },
    });
  };

  const getNodeList = async () => {
    return call(dependencies!, {
      operationId: "node.list",
    });
  };

  const getEdgeList = async (projectId: string) => {
    return call(dependencies!, {
      operationId: "edge.list",
      parameters: { id: projectId },
    });
  };

  const getProjectGraph = async (projectId: string) => {
    return call(dependencies!, {
      operationId: "project.graph",
      parameters: { id: projectId },
    });
  };

  const UNKNOWN_PROJECT_ID = "01KRZ3NDEKTSV4RRFFQ69G5FAW";

  it("acceptance sequence: project.nodes, node.list union, project.graph snapshot with edge.list equality", async () => {
    const projectA = await importPlan("project-a", planA);
    const projectB = await importPlan("project-b", planB);

    const nodesA = await getProjectNodes(projectA);
    assert.equal(nodesA.status, 200);
    assert.ok(nodesA.ok);
    const nodeIdsA = (nodesA.body as { nodes: { id: string }[] }).nodes.map(
      (n) => n.id,
    );
    assert.deepEqual(nodeIdsA, [
      "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV",
      "task_01DRZ3NDEKTSV4RRFFQ69G5FAV",
      "task_01ERZ3NDEKTSV4RRFFQ69G5FAV",
    ]);

    const nodesB = await getProjectNodes(projectB);
    assert.equal(nodesB.status, 200);
    assert.ok(nodesB.ok);
    const nodeIdsB = (nodesB.body as { nodes: { id: string }[] }).nodes.map(
      (n) => n.id,
    );
    assert.deepEqual(nodeIdsB, [
      "initiative_01FQZ3NDEKTSV4RRFFQ69G5FAV",
      "objective_01GRZ3NDEKTSV4RRFFQ69G5FAV",
      "task_01HRZ3NDEKTSV4RRFFQ69G5FAV",
      "task_01JRZ3NDEKTSV4RRFFQ69G5FAV",
    ]);

    const allNodes = await getNodeList();
    assert.equal(allNodes.status, 200);
    assert.ok(allNodes.ok);
    const allNodeIds = (allNodes.body as { nodes: { id: string }[] }).nodes.map(
      (n) => n.id,
    );
    assert.deepEqual(allNodeIds, [
      "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "initiative_01FQZ3NDEKTSV4RRFFQ69G5FAV",
      "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV",
      "objective_01GRZ3NDEKTSV4RRFFQ69G5FAV",
      "task_01DRZ3NDEKTSV4RRFFQ69G5FAV",
      "task_01ERZ3NDEKTSV4RRFFQ69G5FAV",
      "task_01HRZ3NDEKTSV4RRFFQ69G5FAV",
      "task_01JRZ3NDEKTSV4RRFFQ69G5FAV",
    ]);

    const graphA = await getProjectGraph(projectA);
    assert.equal(graphA.status, 200);
    assert.ok(graphA.ok);
    const graphNodeKeysA = (
      graphA.body as { nodes: { key: string }[] }
    ).nodes.map((n) => n.key);
    assert.deepEqual(graphNodeKeysA, nodeIdsA);

    const graphEdgesA = (
      graphA.body as {
        edges: { key: string; source: string; target: string }[];
      }
    ).edges;
    const graphEdgeKeysA = graphEdgesA.map((e) => e.key);

    const edgeListA = await getEdgeList(projectA);
    assert.equal(edgeListA.status, 200);
    assert.ok(edgeListA.ok);
    const edgeListEdgeIdsA = (
      edgeListA.body as {
        edges: { id: string; fromNode: string; toNode: string }[];
      }
    ).edges.map((e) => e.id);

    assert.deepEqual(graphEdgeKeysA, edgeListEdgeIdsA);

    const edgePairsA = graphEdgesA.map((e) => `${e.source}->${e.target}`);
    assert.deepEqual(edgePairsA, [
      `task_01ERZ3NDEKTSV4RRFFQ69G5FAV->task_01DRZ3NDEKTSV4RRFFQ69G5FAV`,
    ]);
  });

  it("project.graph on an empty project returns 200 with empty arrays and null revision", async () => {
    const createResult = await call(dependencies!, {
      operationId: "project.create",
      body: { name: "empty-project" },
    });
    assert.equal(createResult.status, 200);
    assert.ok(createResult.ok);
    const projectId = (createResult.body as { id: string }).id;

    const graph = await getProjectGraph(projectId);
    assert.equal(graph.status, 200);
    assert.ok(graph.ok);
    assert.deepEqual((graph.body as { nodes: unknown[] }).nodes, []);
    assert.deepEqual((graph.body as { edges: unknown[] }).edges, []);
    assert.equal(
      (graph.body as { attributes: { revision: string | null } }).attributes
        .revision,
      null,
    );
  });

  it("project.nodes and project.graph on unknown project return 404", async () => {
    const unknown = UNKNOWN_PROJECT_ID;
    const nodes = await getProjectNodes(unknown);
    assert.equal(nodes.status, 404);
    const graph = await getProjectGraph(unknown);
    assert.equal(graph.status, 404);
  });

  it("project.graph on unchanged graph returns byte-identical bodies via Buffer.compare", async () => {
    const planForGraph: readonly { path: string; content: string }[] = [
      {
        path: "plan/bytewise/initiative.md",
        content: `---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FCV
kind: initiative
title: Bytewise Initiative
---
Bootstrap.
`,
      },
      {
        path: "plan/bytewise/og--alpha/objective.md",
        content: `---
id: objective_01BQZ3NDEKTSV4RRFFQ69G5FCV
kind: objective
title: Bytewise Alpha
repo: kanthord-verify
---
Deliver.
`,
      },
      {
        path: "plan/bytewise/og--alpha/01-t.md",
        content: `---
id: task_01DRZ3NDEKTSV4RRFFQ69G5FCV
kind: task
title: Bytewise Task
worker: tdd@1
---
Do it.

## Acceptance criteria

- Done.
`,
      },
    ];

    const projectId = await importPlan("bytewise-project", planForGraph);

    const fetchGraphRaw = async (id: string): Promise<string> => {
      const request = {
        operationId: "project.graph",
        parameters: { id },
      };
      const { buildRequest } = await import("./cli/client.ts");
      const { url, init } = buildRequest(dependencies!, request);
      const response = await dependencies!.fetch(url, init);
      return response.text();
    };

    const graphResult = await getProjectGraph(projectId);
    assert.equal(graphResult.status, 200);
    assert.ok(graphResult.ok);
    const bytewiseGraph = graphResult.body as { nodes: { key: string }[] };
    assert.deepEqual(
      bytewiseGraph.nodes.map((node) => node.key),
      [
        "initiative_01ARZ3NDEKTSV4RRFFQ69G5FCV",
        "objective_01BQZ3NDEKTSV4RRFFQ69G5FCV",
        "task_01DRZ3NDEKTSV4RRFFQ69G5FCV",
      ],
    );

    const firstBody = await fetchGraphRaw(projectId);
    const secondBody = await fetchGraphRaw(projectId);

    assert.equal(
      Buffer.compare(
        Buffer.from(firstBody, "utf8"),
        Buffer.from(secondBody, "utf8"),
      ),
      0,
    );
  });

  it("project.nodes and project.graph on a project with exactly one node and no edges return one node and zero edges", async () => {
    const createResult = await call(dependencies!, {
      operationId: "project.create",
      body: { name: "one-node-project" },
    });
    assert.equal(createResult.status, 200);
    assert.ok(createResult.ok);
    const projectId = (createResult.body as { id: string }).id;

    const bindResult = await call(dependencies!, {
      operationId: "project.repositories",
      parameters: { id: projectId },
      body: { repositories: ["repo_a"] },
    });
    assert.equal(bindResult.status, 200);
    assert.ok(bindResult.ok);

    const createNodeResult = await call(dependencies!, {
      operationId: "node.create",
      parameters: { id: projectId },
      body: {
        fromRevision: null,
        node: {
          kind: "initiative",
          title: "One Node Project",
          instruction: "Single node.",
          worker: null,
          dependsOn: [],
        },
      },
    });
    assert.equal(createNodeResult.status, 200);
    assert.ok(createNodeResult.ok);
    const nodeId = (createNodeResult.body as { id: string }).id;

    const nodesResult = await getProjectNodes(projectId);
    assert.equal(nodesResult.status, 200);
    assert.ok(nodesResult.ok);
    assert.ok(nodesResult.body);
    const nodeList = (nodesResult.body as { nodes: { id: string }[] }).nodes;
    assert.equal(nodeList.length, 1);
    assert.ok(nodeList[0]);
    assert.equal(nodeList[0].id, nodeId);

    const graphResult = await getProjectGraph(projectId);
    assert.equal(graphResult.status, 200);
    assert.ok(graphResult.ok);
    assert.ok(graphResult.body);
    const graph = graphResult.body as {
      nodes: { key: string }[];
      edges: { key: string }[];
      attributes: { revision: string | null };
    };
    assert.equal(graph.nodes.length, 1);
    assert.ok(graph.nodes[0]);
    assert.equal(graph.nodes[0].key, nodeId);
    assert.equal(graph.edges.length, 0);
    assert.equal(typeof graph.attributes.revision, "string");
    assert.ok(graph.attributes.revision);
  });

  it("project.nodes and node.list return identical member names for the same node", async () => {
    const createResult = await call(dependencies!, {
      operationId: "project.create",
      body: { name: "shape-test-project" },
    });
    assert.equal(createResult.status, 200);
    assert.ok(createResult.ok);
    const projectId = (createResult.body as { id: string }).id;

    const bindResult = await call(dependencies!, {
      operationId: "project.repositories",
      parameters: { id: projectId },
      body: { repositories: ["repo_a"] },
    });
    assert.equal(bindResult.status, 200);
    assert.ok(bindResult.ok);

    const createNodeResult = await call(dependencies!, {
      operationId: "node.create",
      parameters: { id: projectId },
      body: {
        fromRevision: null,
        node: {
          kind: "initiative",
          title: "Shape Test Initiative",
          instruction: "Test node shape.",
          worker: null,
          dependsOn: [],
        },
      },
    });
    if (!createNodeResult.ok) {
      assert.fail(
        `node.create failed with ${createNodeResult.status}: ${createNodeResult.code} - ${createNodeResult.message} - ${JSON.stringify(createNodeResult.details)}`,
      );
    }
    assert.equal(createNodeResult.status, 200);
    assert.ok(createNodeResult.ok);
    const nodeId = (createNodeResult.body as { id: string }).id;

    const projectNodesResult = await getProjectNodes(projectId);
    assert.equal(projectNodesResult.status, 200);
    assert.ok(projectNodesResult.ok);
    const projectNodes = (projectNodesResult.body as { nodes: NodeListItem[] })
      .nodes;
    const scopedNode = projectNodes.find((n) => n.id === nodeId);
    assert.ok(scopedNode, `Node ${nodeId} not found in project.nodes`);

    const nodeListResult = await getNodeList();
    if (!nodeListResult.ok) {
      assert.fail(
        `node.list failed with ${nodeListResult.status}: ${nodeListResult.code} - ${nodeListResult.message} - ${JSON.stringify(nodeListResult.details)}`,
      );
    }
    assert.equal(nodeListResult.status, 200);
    assert.ok(nodeListResult.ok);
    const allNodes = (nodeListResult.body as { nodes: NodeListItem[] }).nodes;
    const globalNode = allNodes.find((n) => n.id === nodeId);
    assert.ok(globalNode, `Node ${nodeId} not found in node.list`);

    const scopedKeys = Object.keys(scopedNode).sort();
    const globalKeys = Object.keys(globalNode).sort();
    assert.deepEqual(
      scopedKeys,
      globalKeys,
      "Member names must be identical between project.nodes and node.list",
    );
  });

  it("attributes.revision equals the plan.export revision before and after one node.create", async () => {
    const createResult = await call(dependencies!, {
      operationId: "project.create",
      body: { name: "revision-parity-project" },
    });
    assert.equal(createResult.status, 200);
    assert.ok(createResult.ok);
    const projectId = (createResult.body as { id: string }).id;

    const bindResult = await call(dependencies!, {
      operationId: "project.repositories",
      parameters: { id: projectId },
      body: { repositories: ["repo_a"] },
    });
    assert.equal(bindResult.status, 200);
    assert.ok(bindResult.ok);

    const firstCreate = await call(dependencies!, {
      operationId: "node.create",
      parameters: { id: projectId },
      body: {
        fromRevision: null,
        node: {
          kind: "initiative",
          title: "Revision Parity One",
          instruction: "First node.",
          worker: null,
          dependsOn: [],
        },
      },
    });
    assert.equal(firstCreate.status, 200);
    assert.ok(firstCreate.ok);
    const firstRevision = (firstCreate.body as { revision: string }).revision;

    const graphBefore = await getProjectGraph(projectId);
    assert.equal(graphBefore.status, 200);
    assert.ok(graphBefore.ok);
    const exportBefore = await call(dependencies!, {
      operationId: "plan.export",
      parameters: { id: projectId },
    });
    assert.equal(exportBefore.status, 200);
    assert.ok(exportBefore.ok);

    const revisionBefore = (
      graphBefore.body as { attributes: { revision: string | null } }
    ).attributes.revision;
    assert.equal(
      revisionBefore,
      (exportBefore.body as { revision: string }).revision,
    );
    assert.equal(revisionBefore, firstRevision);

    const secondCreate = await call(dependencies!, {
      operationId: "node.create",
      parameters: { id: projectId },
      body: {
        fromRevision: firstRevision,
        node: {
          kind: "initiative",
          title: "Revision Parity Two",
          instruction: "Second node.",
          worker: null,
          dependsOn: [],
        },
      },
    });
    assert.equal(secondCreate.status, 200);
    assert.ok(secondCreate.ok);
    const secondRevision = (secondCreate.body as { revision: string }).revision;

    const graphAfter = await getProjectGraph(projectId);
    assert.equal(graphAfter.status, 200);
    assert.ok(graphAfter.ok);
    const exportAfter = await call(dependencies!, {
      operationId: "plan.export",
      parameters: { id: projectId },
    });
    assert.equal(exportAfter.status, 200);
    assert.ok(exportAfter.ok);

    const revisionAfter = (
      graphAfter.body as { attributes: { revision: string | null } }
    ).attributes.revision;
    assert.equal(
      revisionAfter,
      (exportAfter.body as { revision: string }).revision,
    );
    assert.equal(revisionAfter, secondRevision);
    assert.notEqual(revisionAfter, revisionBefore);
  });
});

type NodeListItem = Readonly<{
  id: string;
  projectId: string;
  kind: string;
  title: string;
  state: string;
  blockReason: string | null;
  discardReason: string | null;
  parentId: string | null;
  dependencies: readonly string[];
}>;
