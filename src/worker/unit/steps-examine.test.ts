import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { temporary, hostEnvironment } from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { background } from "../../kernel/context.ts";
import type { Revision } from "../../mission/contract.ts";
import { ExecutionRun, ExecutionStop } from "./execution-run.ts";
import { anthropicSetup, repositorySetup } from "./test-support.ts";
import { CHECKOUTS_DIRECTORY, WorkspaceRoot } from "./workspace.ts";
import type { MethodClients } from "./method-clients.ts";
import type { RepositoryTransport } from "../contract.ts";
import type { NativeAgent } from "./native-agent.ts";
import { runStepsExamine } from "./steps-examine.ts";
import {
  DeadlineExceeded,
  throwIfCancelled,
  type CancellationContext,
} from "../../kernel/context.ts";
import { ExecutionBudget } from "./budget.ts";
import { executionBoundary } from "./native-method.ts";
import { setTimeout } from "node:timers/promises";

const EVIDENCE_UPLOAD_COUNT = 1;
const EXPECTED_RELEASES = 1;
const NO_EVIDENCE_UPLOADS = 0;
test("initiative reports its dependencies once and removes its workspace", async (t) => {
  const scenarios = [
    {
      states: ["Completed"],
      report: "report",
      further: false,
      evidence: true,
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
      node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      trace_id: "trace",
      root_span_id: "1".repeat(16),
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
        "execution.dependency.list": async () =>
          completed({
            items: [{ id: "dependency", state: scenario.states[reads++] }],
            next_cursor: null,
          }),
        "execution.dependency.outcome.list": empty,
        "execution.dependency.evidence.list": empty,
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
            stop: null,
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
    const pending = runStepsExamine(
      {
        setup,
        claim,
        workspaces,
        transport: {} as RepositoryTransport,
        env: hostEnvironment(),
      },
      run,
      {
        content: {
          name: "initiative",
          requirement: "report",
          criterion: "report",
          verifications: [],
        },
      } as unknown as Revision,
      new ExecutionBudget({
        ...claim,
        resource_budget: setup.resource_budget,
      }),
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
      node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      created_at: Date.now() - (duringOpen ? 0 : 10000),
      expired_at: Date.now() + 60000,
      trace_id: "trace",
      root_span_id: "1".repeat(16),
    };
    const page = async () => ({
      type: "completed",
      status: 200,
      data: { items: [], next_cursor: null },
    });
    let releases = 0;
    const clients = {
      mission: {
        "execution.dependency.list": page,
        "execution.dependency.outcome.list": page,
        "execution.dependency.evidence.list": page,
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
      await runStepsExamine(
        {
          setup,
          claim,
          workspaces,
          transport: {} as RepositoryTransport,
          env: hostEnvironment(),
        },
        run,
        {} as Revision,
        new ExecutionBudget({
          ...claim,
          resource_budget: setup.resource_budget,
        }),
        open,
      ),
      { kind: "released", furtherWork: true },
    );
    assert.equal(releases, EXPECTED_RELEASES);
  }
});

test("an initiative that its agent deadline cuts releases with further work and no failure stop", async (t) => {
  const setup = anthropicSetup({ repositories: [] });
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
  const page = async () => ({
    type: "completed",
    status: 200,
    data: { items: [], next_cursor: null },
  });
  const releases: unknown[] = [];
  const clients = {
    mission: {
      "execution.dependency.list": page,
      "execution.dependency.outcome.list": page,
      "execution.dependency.evidence.list": page,
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
  const budget = new ExecutionBudget({
    ...claim,
    resource_budget: setup.resource_budget,
  });
  let context: CancellationContext | undefined;
  const open = async () => {
    context = budget.agentContext(run.operationContext);
    return {
      budget,
      async instruct() {
        context!.cancel(new DeadlineExceeded());
        throwIfCancelled(context!);
      },
      lastText: () => undefined,
    } as unknown as NativeAgent;
  };
  const workspaces = WorkspaceRoot.open(temporary(t));
  const end = await executionBoundary(run, () =>
    runStepsExamine(
      {
        setup,
        claim,
        workspaces,
        transport: {} as RepositoryTransport,
        env: hostEnvironment(),
      },
      run,
      {
        content: {
          name: "initiative",
          requirement: "report",
          criterion: "report",
          verifications: [],
        },
      } as unknown as Revision,
      budget,
      open,
    ),
  );
  assert.deepEqual(end, { kind: "released", furtherWork: true });
  assert.deepEqual(releases, [{ further_work: true, stop: null }]);
});

test("an initiative with two repository bindings runs from checkouts/ and lists each repository in the work and examine prompts", async (t) => {
  const names = ["first", "second"];
  const setup = anthropicSetup({
    repositories: names.map((name) => ({ ...repositorySetup(), name })),
  });
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
  const output = join(temporary(t), "directory");
  const completed = (data: unknown) => ({
    type: "completed",
    status: 200,
    data,
  });
  const page = async () => completed({ items: [], next_cursor: null });
  const clients = {
    mission: {
      "execution.dependency.list": page,
      "execution.dependency.outcome.list": page,
      "execution.dependency.evidence.list": page,
      "evidence.submit": async () => completed({ evidence: {} }),
    },
    scheduler: {
      executionRelease: async () => completed({}),
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
  const key = workspaces.executionKey(claim.execution_id);
  const root = join(key, CHECKOUTS_DIRECTORY);
  const transport = {
    proveSshIdentity: async () => {},
    cloneSnapshot: async () => "a".repeat(40),
  } as unknown as RepositoryTransport;
  const opened: { directory: string; checkouts: readonly string[] }[] = [];
  const texts: string[] = [];
  const open = async (directory: string, checkouts: readonly string[]) => {
    opened.push({ directory, checkouts });
    return {
      instruct: async (work: { text: string }, text: string) => {
        texts.push(work.text, text);
      },
      lastText: () => "report",
      budget: { exhausted: () => false },
    } as unknown as NativeAgent;
  };
  assert.deepEqual(
    await runStepsExamine(
      {
        setup,
        claim,
        workspaces,
        transport,
        env: hostEnvironment(),
      },
      run,
      {
        content: {
          name: "initiative",
          requirement: "examine",
          criterion: "examine",
          verifications: [`pwd > ${output}`],
        },
      } as unknown as Revision,
      new ExecutionBudget({
        ...claim,
        resource_budget: setup.resource_budget,
      }),
      open,
    ),
    { kind: "released", furtherWork: false },
  );
  assert.equal(readFileSync(output, "utf8").trim(), root);
  assert.deepEqual(opened, [
    { directory: root, checkouts: names.map((name) => join(root, name)) },
  ]);
  const [work, examine] = texts;
  for (const text of [work, examine])
    for (const name of names)
      assert.ok(
        text?.includes(
          `Repository ${name}: directory \`${name}\`, base branch \`main\``,
        ),
      );
});
