import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import { background } from "../kernel/context.ts";
import { EndReason, ExecutionRun, ExecutionStop } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import { anthropicSetup } from "./test-support.ts";
import { WorkspaceRoot } from "./workspace.ts";
import type { MethodClients } from "./method-clients.ts";
import type { RepositoryTransport } from "./contract.ts";
import type { NativeAgent } from "./native-agent.ts";
import type { WorkPrompt } from "../agent/prompt-composer.ts";
import { requestAndRelease, runEvaluation } from "./evaluation.ts";
import { ActionResultKind } from "./contract.ts";
import { JUDGEMENT_MARKER, repairInstruction } from "./judgement.ts";

const NO_RELEASES = 0;
const SINGLE_RELEASE = 1;
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
      execution_id: setup.execution_id,
      node_id: "node",
      attempt: 1,
      pinned_revision: 1,
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      trace_id: "trace",
    };
    const releases: unknown[] = [];
    const clients = {
      worker: {
        "action.request": async (input: unknown) => {
          assert.deepEqual(input, {
            params: { execution_id: claim.execution_id },
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
        executionRelease: async (input: { body: unknown }) => {
          releases.push(input.body);
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
    const stop = { reason: EndReason.ActionUnsettled, code: null };
    if (accepted) {
      assert.deepEqual(await requestAndRelease(run), {
        kind: "released",
        furtherWork: false,
      });
      assert.deepEqual(releases, [{ further_work: false }]);
    } else {
      assert.deepEqual(
        await executionBoundary(run, () => requestAndRelease(run)),
        { kind: "released", furtherWork: true, stop },
      );
      assert.deepEqual(releases, [{ further_work: true, stop }]);
    }
  }
});
test("evaluation writes failed-verification assessments without inference and gates malformed judgement", async (t) => {
  for (const scenario of [
    { command: "false", texts: [""], result: "criterion-not-met", opens: 0 },
    {
      command: "true",
      texts: ['kanthord-judgement: {"result":"success","rationale":"met"}'],
      result: "success",
      opens: 1,
    },
    {
      command: "true",
      texts: ["invalid", "still invalid"],
      result: null,
      opens: 1,
      repaired: true,
    },
    {
      command: "true",
      texts: [
        'kanthord-judgement: {"result":"criterion-not-met","rationale":"unmet"}',
      ],
      result: "criterion-not-met",
      opens: 1,
      reworked: true,
    },
    {
      command: "true",
      texts: ["invalid", "partial"],
      result: null,
      opens: 1,
      repaired: true,
      budgetEndsOnRepair: true,
      stop: EndReason.AssessmentAbsent,
    },
    {
      command: "true",
      texts: [
        'канthord-judgement: {"result":"success","rationale":"met"}',
        'kanthord-judgement: {"result":"success","rationale":"met"}',
      ],
      result: "success",
      opens: 1,
      repaired: true,
    },
    {
      command: "true",
      texts: [
        'kanthord-judgement: {"result":"success","rationale":"children weighed"}',
      ],
      result: "success",
      opens: 1,
      initiative: true,
    },
    { command: "true", texts: [""], result: null, opens: 0, refused: true },
  ]) {
    const setup = anthropicSetup({ repositories: [] });
    const claim = {
      execution_id: setup.execution_id,
      node_id: createIdentity("node"),
      attempt: 1,
      pinned_revision: 1,
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      trace_id: "trace",
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
    const instructions: string[] = [];
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
            ...(scenario.initiative ? {} : { tasks: [] }),
          }),
        "execution.evidence.list": async () =>
          complete({
            items: [
              evidence,
              {
                id: "request",
                requirement_key: "action",
                end_state: "expected",
                assets: [],
              },
            ],
            next_cursor: null,
          }),
        "execution.objective.list": async () =>
          complete({
            items: [{ id: "child", state: "Completed" }],
            next_cursor: null,
          }),
        "execution.objective.outcome.list": async () =>
          complete({
            items: [
              { id: "child-outcome", result: "success", node_id: "child" },
            ],
            next_cursor: null,
          }),
        "execution.objective.evidence.list": async () =>
          complete({ items: [], next_cursor: null }),
        "execution.evidence.asset.content.get": async () =>
          complete({
            asset_id: assetId,
            address,
            data: Buffer.from("report").toString("base64"),
            encoding: "base64",
            media_type: "text/markdown",
          }),
        "evidence.submit": async (input: {
          body: { verification: { results: unknown[] } };
        }) => {
          assert.equal(input.body.verification.results.length, SINGLE_RELEASE);
          if (scenario.refused)
            return {
              type: "failure",
              status: 403,
              error: {
                error: {
                  code: "gateway.invocation.execution_proof_failed",
                  message: "ended",
                  details: null,
                },
                request_id: "test",
              },
            };
          return complete({ evidence: { id: "verification" } });
        },
        "assessment.submit": async (input: {
          body: {
            result: string;
            evidence_ids: string[];
            child_outcome_ids: string[];
            rationale: string;
          };
        }) => {
          assessments++;
          assert.ok(reported);
          assert.equal(input.body.result, scenario.result);
          assert.deepEqual(input.body.evidence_ids, ["verification", "placed"]);
          assert.deepEqual(
            input.body.child_outcome_ids,
            scenario.initiative ? ["child-outcome"] : [],
          );
          if (!scenario.opens)
            assert.match(input.body.rationale, /Verification 1 `false` failed/);
          if (scenario.reworked)
            return complete({
              assessment: { result: scenario.result },
              node: { state: "Available" },
              outcome: null,
            });
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
        budget: {
          exhausted: () =>
            scenario.budgetEndsOnRepair === true &&
            instructions.at(-1) === repairInstruction(JUDGEMENT_MARKER),
        },
        instruct: async (_work: WorkPrompt, instruction: string) => {
          instructions.push(instruction);
          if (instruction === repairInstruction(JUDGEMENT_MARKER)) return;
          assert.ok(instruction.includes(assetId));
          if (scenario.initiative) {
            assert.match(instruction, /child-outcome/);
            assert.match(instruction, /Completed/);
          }
        },
        lastText: () =>
          scenario.texts[
            Math.min(instructions.length, scenario.texts.length) - 1
          ],
      } as unknown as NativeAgent;
    };
    const pending = runEvaluation(
      { setup, claim, workspaces, transport: {} as RepositoryTransport },
      run,
      open,
    );
    if (scenario.stop) await assert.rejects(pending, { reason: scenario.stop });
    else if (scenario.result === null)
      await assert.rejects(pending, ExecutionStop);
    else if (scenario.reworked)
      assert.deepEqual(await pending, {
        kind: "ended",
        reason: EndReason.Revoked,
        code: null,
      });
    else
      assert.deepEqual(await pending, {
        kind: "closed",
        outcomeId: "outcome",
      });
    assert.equal(opens, scenario.opens);
    assert.equal(
      instructions.at(-1) === repairInstruction(JUDGEMENT_MARKER),
      scenario.repaired === true,
    );
    assert.equal(
      assessments,
      scenario.result === null ? NO_RELEASES : SINGLE_RELEASE,
    );
    assert.equal(
      existsSync(workspaces.executionKey(claim.execution_id)),
      false,
    );
  }
});
