import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import { background } from "../kernel/context.ts";
import { ExecutionRun, ExecutionStop } from "./execution-run.ts";
import { anthropicSetup } from "./test-support.ts";
import { WorkspaceRoot } from "./workspace.ts";
import type { MethodClients } from "./method-clients.ts";
import type { RepositoryTransport } from "./contract.ts";
import type { NativeAgent } from "./native-agent.ts";
import { requestAndRelease, runEvaluation } from "./evaluation.ts";
import { ActionResultKind } from "./contract.ts";

const ZERO = 0;
const ONE = 1;
test("reviewer release accepts only settled or prerequisite-waiting action results", async (t) => {
  for (const kinds of [
    [],
    [ActionResultKind.Submitted],
    [ActionResultKind.AwaitingPrerequisite],
    [ActionResultKind.FailedBeforeEffect],
    [ActionResultKind.Uncertain],
  ]) {
    const setup = anthropicSetup();
    const claim = {
      executionId: setup.executionId,
      nodeId: "node",
      attempt: 1,
      pinnedRevision: 1,
      createdAt: Date.now(),
      expiredAt: Date.now() + 60000,
      traceId: "trace",
    };
    let releases = 0;
    const clients = {
      worker: {
        "action.request": async (input: unknown) => {
          assert.deepEqual(input, {
            params: { executionId: claim.executionId },
            query: {},
            body: null,
          });
          return {
            type: "completed",
            status: 200,
            data: { items: kinds.map((kind) => ({ kind })) },
          };
        },
      },
      scheduler: {
        executionRelease: async () => {
          releases++;
          return { type: "completed", status: 200, data: {} };
        },
      },
    } as unknown as MethodClients;
    const run = new ExecutionRun({
      claim,
      clients,
      credentials: { release: async () => {} },
      context: background,
    });
    t.after(() => run.dispose());
    const accepted = kinds.every(
      (kind) =>
        kind === ActionResultKind.Submitted ||
        kind === ActionResultKind.AwaitingPrerequisite,
    );
    if (accepted)
      assert.deepEqual(await requestAndRelease(run), {
        kind: "released",
        furtherWork: false,
      });
    else await assert.rejects(requestAndRelease(run), ExecutionStop);
    assert.equal(releases, accepted ? ONE : ZERO);
  }
});
test("evaluation writes failed-verification assessments without inference and gates malformed judgement", async (t) => {
  for (const scenario of [
    { command: "false", text: "", result: "criterion-not-met", opens: 0 },
    {
      command: "true",
      text: 'kanthord-judgement: {"result":"success","rationale":"met"}',
      result: "success",
      opens: 1,
    },
    { command: "true", text: "invalid", result: null, opens: 1 },
  ]) {
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
    const evidence = {
      id: "placed",
      assets: [{ id: assetId, kind: "produced", address }],
    };
    const complete = (data: unknown) => ({
      type: "completed",
      status: 200,
      data,
    });
    let assessments = 0;
    let opens = 0;
    let reported = false;
    const clients = {
      mission: {
        "execution.pinnedRevision.get": async () =>
          complete({
            content: {
              name: "objective",
              requirement: "work",
              criterion: "met",
              verifications: [scenario.command],
              bindings: [],
            },
            tasks: [],
          }),
        "execution.evidence.list": async () =>
          complete({ items: [evidence], nextCursor: null }),
        "execution.evidence.asset.content.get": async () =>
          complete({
            assetId,
            address,
            data: Buffer.from("report").toString("base64"),
            encoding: "base64",
            mediaType: "text/markdown",
          }),
        "evidence.submit": async (input: {
          body: { verification: { results: unknown[] } };
        }) => {
          assert.equal(input.body.verification.results.length, ONE);
          return complete({ evidence: { id: "verification" } });
        },
        "assessment.submit": async (input: {
          body: {
            result: string;
            evidenceIds: string[];
            childOutcomeIds: string[];
            rationale: string;
          };
        }) => {
          assessments++;
          assert.ok(reported);
          assert.equal(input.body.result, scenario.result);
          assert.deepEqual(input.body.evidenceIds, ["verification", "placed"]);
          assert.deepEqual(input.body.childOutcomeIds, []);
          if (!scenario.opens)
            assert.match(input.body.rationale, /Verification 1 `false` failed/);
          return complete({ outcome: { id: "outcome" } });
        },
      },
    } as unknown as MethodClients;
    const run = new ExecutionRun({
      claim,
      clients,
      credentials: {
        release: async () => {
          reported = true;
        },
      },
      context: background,
    });
    t.after(() => run.dispose());
    const workspaces = WorkspaceRoot.open(temporary(t));
    const open = async () => {
      opens++;
      return {
        budget: { exhausted: () => false },
        instruct: async () => {},
        lastText: () => scenario.text,
      } as unknown as NativeAgent;
    };
    const pending = runEvaluation(
      { setup, claim, workspaces, transport: {} as RepositoryTransport },
      run,
      open,
    );
    if (scenario.result === null) await assert.rejects(pending, ExecutionStop);
    else
      assert.deepEqual(await pending, { kind: "closed", outcomeId: "outcome" });
    assert.equal(opens, scenario.opens);
    assert.equal(assessments, scenario.result === null ? ZERO : ONE);
    assert.equal(existsSync(workspaces.executionKey(claim.executionId)), false);
  }
});
