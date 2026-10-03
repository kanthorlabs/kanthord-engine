import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, statSync } from "node:fs";
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
