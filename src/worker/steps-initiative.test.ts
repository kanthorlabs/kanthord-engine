import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import { background } from "../kernel/context.ts";
import type { Revision } from "../mission/contract.ts";
import { ExecutionRun, ExecutionStop } from "./execution-run.ts";
import { anthropicSetup } from "./test-support.ts";
import { WorkspaceRoot } from "./workspace.ts";
import type { MethodClients } from "./method-clients.ts";
import type { RepositoryTransport } from "./contract.ts";
import type { NativeAgent } from "./native-agent.ts";
import { runStepsInitiative } from "./steps-initiative.ts";

const FIRST = 1;
const ZERO = 0;
test("initiative reports terminal objectives, rechecks graph changes and removes its workspace", async (t) => {
  const scenarios = [
    {
      states: ["Completed", "Completed"],
      report: "report",
      further: false,
      evidence: true,
      opens: 1,
    },
    {
      states: ["Available"],
      report: "report",
      further: true,
      evidence: false,
      opens: 0,
    },
    {
      states: ["Completed", "Available"],
      report: "report",
      further: true,
      evidence: false,
      opens: 1,
    },
    {
      states: ["Completed"],
      report: " ",
      further: null,
      evidence: false,
      opens: 1,
    },
  ];
  for (const scenario of scenarios) {
    const setup = anthropicSetup();
    const claim = {
      executionId: setup.executionId,
      nodeId: createIdentity("node"),
      attempt: 1,
      pinnedRevision: 1,
      createdAt: Date.now(),
      expiredAt: Date.now() + 60000,
      traceId: "trace",
    };
    const workspaces = WorkspaceRoot.open(temporary(t));
    let reads = 0;
    let opens = 0;
    let evidence = 0;
    const completed = (data: unknown) => ({
      type: "completed",
      status: 200,
      data,
    });
    const empty = async () => completed({ items: [], nextCursor: null });
    const clients = {
      mission: {
        "execution.objective.list": async () =>
          completed({
            items: [{ id: "objective", state: scenario.states[reads++] }],
            nextCursor: null,
          }),
        "execution.objective.outcome.list": empty,
        "execution.objective.evidence.list": empty,
        "evidence.submit": async (input: {
          body: { assets: { content: { data: string } }[] };
        }) => {
          evidence++;
          assert.equal(
            Buffer.from(
              input.body.assets[0]!.content.data,
              "base64",
            ).toString(),
            scenario.report,
          );
          return completed({ evidence: {} });
        },
      },
      scheduler: {
        executionRelease: async (input: { body: unknown }) => {
          assert.deepEqual(input.body, { furtherWork: scenario.further });
          return completed({});
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
    const open = async () => {
      opens++;
      return {
        instruct: async () => {},
        lastText: () => scenario.report,
        budget: { exhausted: () => false },
      } as unknown as NativeAgent;
    };
    const pending = runStepsInitiative(
      { setup, claim, workspaces, transport: {} as RepositoryTransport },
      run,
      {
        content: {
          name: "initiative",
          requirement: "report",
          criterion: "report",
          verifications: [],
        },
      } as unknown as Revision,
      open,
    );
    if (scenario.further === null) await assert.rejects(pending, ExecutionStop);
    else
      assert.deepEqual(await pending, {
        kind: "released",
        furtherWork: scenario.further,
      });
    assert.equal(evidence, scenario.evidence ? FIRST : ZERO);
    assert.equal(opens, scenario.opens);
    assert.equal(existsSync(workspaces.executionKey(claim.executionId)), false);
  }
});
