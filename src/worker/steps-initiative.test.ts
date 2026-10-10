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
import { DeadlineExceeded } from "../kernel/context.ts";
import { setTimeout } from "node:timers/promises";

const EVIDENCE_UPLOAD_COUNT = 1;
const EXPECTED_RELEASES = 1;
const NO_EVIDENCE_UPLOADS = 0;
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
      execution_id: setup.execution_id,
      node_id: createIdentity("node"),
      attempt: 1,
      pinned_revision: 1,
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      trace_id: "trace",
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
    const empty = async () => completed({ items: [], next_cursor: null });
    const clients = {
      mission: {
        "execution.objective.list": async () =>
          completed({
            items: [{ id: "objective", state: scenario.states[reads++] }],
            next_cursor: null,
          }),
        "execution.objective.outcome.list": empty,
        "execution.objective.evidence.list": empty,
        "evidence.submit": async (input: {
          body: { assets: { content: { data: string } }[] };
        }) => {
          evidence++;
          const stored = Buffer.from(
            input.body.assets[0]!.content.data,
            "base64",
          ).toString();
          assert.ok(stored.startsWith("## Facts recorded by KanthorD"));
          assert.ok(stored.endsWith(`## Assessment\n\n${scenario.report}`));
          return completed({ evidence: {} });
        },
      },
      scheduler: {
        executionRelease: async (input: { body: unknown }) => {
          assert.deepEqual(input.body, {
            further_work: scenario.further,
            progress: true,
          });
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
    assert.equal(
      evidence,
      scenario.evidence ? EVIDENCE_UPLOAD_COUNT : NO_EVIDENCE_UPLOADS,
    );
    assert.equal(opens, scenario.opens);
    assert.equal(
      existsSync(workspaces.executionKey(claim.execution_id)),
      false,
    );
  }
});

test("B4 initiative releases when reads or agent opening consume the wall budget", async (t) => {
  for (const duringOpen of [false, true]) {
    const setup = anthropicSetup({
      repositories: [],
      resource_budget: { wall_time_ms: 100 },
    });
    const claim = {
      execution_id: setup.execution_id,
      node_id: createIdentity("node"),
      attempt: 1,
      pinned_revision: 1,
      created_at: Date.now() - (duringOpen ? 0 : 10000),
      expired_at: Date.now() + 60000,
      trace_id: "trace",
    };
    const page = async () => ({
      type: "completed",
      status: 200,
      data: { items: [], next_cursor: null },
    });
    let releases = 0;
    const clients = {
      mission: {
        "execution.objective.list": page,
        "execution.objective.outcome.list": page,
        "execution.objective.evidence.list": page,
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
    const open = async () => {
      assert.ok(duringOpen);
      await setTimeout(120);
      throw new DeadlineExceeded();
    };
    const workspaces = WorkspaceRoot.open(temporary(t));
    assert.deepEqual(
      await runStepsInitiative(
        { setup, claim, workspaces, transport: {} as RepositoryTransport },
        run,
        {} as Revision,
        open,
      ),
      { kind: "released", furtherWork: true },
    );
    assert.equal(releases, EXPECTED_RELEASES);
  }
});
