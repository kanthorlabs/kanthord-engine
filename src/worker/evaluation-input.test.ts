import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, statSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Evidence } from "../mission/contract.ts";
import type { MethodClients } from "./method-clients.ts";
import { anthropicSetup } from "./test-support.ts";
import { ExecutionRun } from "./execution-run.ts";
import { NodeKind } from "./native-agent.ts";
import { WorkspaceRoot, WorkspaceKind } from "./workspace.ts";
import type { RepositoryTransport } from "./contract.ts";
import {
  snapshotOf,
  placedOf,
  prepareEvaluation,
  verificationCommands,
} from "./evaluation-input.ts";

test("snapshot selection excludes requests and verifications and orders by identity", () => {
  const asset = {
    kind: "repository",
    address: { kind: "repository", bindingId: "binding", commit: "head" },
  };
  const evidence = [
    { id: "a", assets: [asset] },
    { id: "b", assets: [asset] },
    { id: "c", assets: [asset], requirementKey: "request" },
    { id: "d", assets: [asset], verification: {} },
  ] as Evidence[];
  assert.deepEqual(snapshotOf(evidence, "binding"), {
    evidenceId: "b",
    commit: "head",
  });
  assert.equal(snapshotOf(evidence, "other"), null);
  assert.equal(placedOf(evidence), null);
});

test("B3 review bundle places all supporting assets beside repositories and removes partial object failures", async (t) => {
  for (const mode of ["success", "failure", "cancel"] as const) {
    const setup = anthropicSetup();
    const repository = {
      bindingId: createIdentity("binding"),
      name: "repo",
      address: "git@github.com:owner/repo.git",
      strategy: { baseBranch: "main" },
      projectPrompt: null,
    };
    setup.repositories = [
      repository,
      { ...repository, bindingId: createIdentity("binding"), name: "other" },
    ];
    const claim = {
      executionId: setup.executionId,
      nodeId: createIdentity("node"),
      attempt: 1,
      pinnedRevision: 1,
      createdAt: Date.now(),
      expiredAt: Date.now() + 60000,
      traceId: "trace",
    };
    const first = createIdentity("evidence_asset");
    const second = createIdentity("evidence_asset");
    const produced = { kind: "produced", sha256: "a".repeat(64) };
    const object = { kind: "object", location: "s3://test/report" };
    const evidence = [
      {
        id: "support",
        assets: [
          { id: first, kind: "produced", address: produced },
          { id: second, kind: "object", address: object },
        ],
      },
    ] as Evidence[];
    const SUCCESS = "success";
    const CANCEL = "cancel";
    const server = createServer((_request, response) => {
      if (mode === CANCEL) {
        run.operationContext.cancel();
        return;
      }
      response.writeHead(mode === SUCCESS ? 200 : 500);
      response.end("object report");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/private-get`;
    const clients = {
      mission: {
        "execution.evidence.asset.content.get": async (input: {
          params: { assetId: string };
        }) => ({
          type: "completed",
          status: 200,
          data:
            input.params.assetId === first
              ? {
                  assetId: first,
                  address: produced,
                  data: Buffer.from("inline report").toString("base64"),
                  encoding: "base64",
                  mediaType: "text/plain",
                }
              : {
                  assetId: second,
                  address: object,
                  getUrl: url,
                  size: 13,
                  mediaType: "text/plain",
                  expiresAt: Date.now() + 60000,
                },
        }),
      },
    } as unknown as MethodClients;
    const run = new ExecutionRun({
      claim,
      clients,
      credentials: { release: async () => {} },
      context: background,
    });
    const workspaces = WorkspaceRoot.open(temporary(t));
    const transport = {
      cloneSnapshot: async () => "a".repeat(40),
    } as unknown as RepositoryTransport;
    try {
      const pending = prepareEvaluation(
        { setup, claim, workspaces, transport },
        run,
        NodeKind.Initiative,
        evidence,
      );
      if (mode !== SUCCESS) {
        await assert.rejects(pending);
        assert.equal(
          existsSync(workspaces.executionKey(claim.executionId)),
          false,
        );
        continue;
      }
      const result = await pending;
      assert.deepEqual(result.evidenceIds, ["support"]);
      const TWO = 2;
      assert.equal(result.reviewBundle.assets.length, TWO);
      assert.equal((result.testedInput as unknown[]).length, TWO);
      assert.equal(JSON.stringify(result).includes(url), false);
      const OBJECT_REPORT = "object report";
      assert.equal(
        readFileSync(join(result.directory, second), "utf8"),
        OBJECT_REPORT,
      );
      workspaces.release(result.directory, WorkspaceKind.Execution);
    } finally {
      run.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});

test("evaluation places a produced report privately and preserves command order", async (t) => {
  const setup = anthropicSetup({ repositories: [] });
  const claim = {
    executionId: setup.executionId,
    nodeId: createIdentity("node"),
    attempt: 1,
    pinnedRevision: 1,
    createdAt: Date.now(),
    expiredAt: Date.now() + 60000,
    traceId: "trace",
  };
  const assetId = createIdentity("evidence_asset");
  const address = { kind: "produced", sha256: "a".repeat(64) };
  const evidence = [
    { id: "evidence", assets: [{ id: assetId, kind: "produced", address }] },
  ] as Evidence[];
  const clients = {
    mission: {
      "execution.evidence.asset.content.get": async () => ({
        type: "completed",
        status: 200,
        data: {
          assetId,
          address,
          data: Buffer.from("report").toString("base64"),
          encoding: "base64",
          mediaType: "text/markdown",
        },
      }),
    },
  } as unknown as MethodClients;
  const run = new ExecutionRun({
    claim,
    clients,
    credentials: { release: async () => {} },
    context: background,
  });
  t.after(() => run.dispose());
  const workspaces = WorkspaceRoot.open(temporary(t));
  const prepared = await prepareEvaluation(
    { setup, claim, workspaces, transport: {} as RepositoryTransport },
    run,
    NodeKind.Initiative,
    evidence,
  );
  assert.deepEqual(prepared.testedInput, address);
  const REPORT = "report";
  const PRIVATE = 0o600;
  assert.equal(readFileSync(join(prepared.directory, assetId), "utf8"), REPORT);
  assert.equal(
    statSync(join(prepared.directory, assetId)).mode & 0o777,
    PRIVATE,
  );
  workspaces.release(prepared.directory, WorkspaceKind.Execution);
  const content = {
    name: "name",
    requirement: "requirement",
    criterion: "criterion",
    bindings: [],
    verifications: ["node"],
  };
  assert.deepEqual(
    verificationCommands({
      content,
      tasks: [
        {
          id: "task",
          filename: "task.md",
          content: { ...content, verifications: ["task"] },
        },
      ],
    }),
    ["node", "task"],
  );
});
