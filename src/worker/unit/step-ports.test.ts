import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { createIdentity } from "../../kernel/identity.ts";
import {
  hostEnvironment,
  stopAfter,
  temporary,
} from "../../kernel/test-support.ts";
import { ExecutionBudget } from "./budget.ts";
import type { StepIo } from "./chain.ts";
import {
  EndReason,
  ExecutionRun,
  ExecutionStop,
  type MethodClaim,
} from "./execution-run.ts";
import {
  type CommandTree,
  type ImplementPorts,
  type PortResult,
  PortResultKind,
} from "./foundry-ports.ts";
import type { MethodClients } from "./method-clients.ts";
import { reportCoder } from "./step-report-coder.ts";
import { baseFetch } from "./step-base-fetch.ts";
import { evidenceHead } from "./step-evidence-head.ts";
import { releaseVerify } from "./step-release-verify.ts";
import type { StepsState } from "./steps-implement.ts";
import { TreeSource } from "./tree-pool.ts";

const WALL_TIME_MS = 60000;
const FAILED_CODE = "repository.connector.git_failed";
const FAILED: PortResult<never> = {
  kind: PortResultKind.Failed,
  code: FAILED_CODE,
  message: FAILED_CODE,
};
const COMMIT_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=a@example.invalid",
];

function claimOf(): MethodClaim {
  return {
    execution_id: createIdentity("execution"),
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + WALL_TIME_MS,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
}

function harness(t: TestContext, ports: Partial<ImplementPorts>) {
  const claim = claimOf();
  const run = new ExecutionRun({
    claim,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
  });
  stopAfter(t, () => run.dispose());
  const budget = new ExecutionBudget({
    ...claim,
    resource_budget: { wall_time_ms: WALL_TIME_MS },
  });
  const io = {
    run,
    budget,
    context: run.operationContext,
    deadline: budget.wallDeadline(),
    resources: new AsyncDisposableStack(),
    spans: run.spans,
    host: {} as StepIo["host"],
    ports: { log: { log: () => {} }, ...ports } as ImplementPorts,
  } satisfies StepIo;
  return { claim, run, budget, io };
}

function failedSubmit(): Pick<ImplementPorts, "evidence"> {
  return { evidence: { submit: async () => FAILED } };
}

function isFailedStop(error: unknown): boolean {
  return (
    error instanceof ExecutionStop &&
    error.reason === EndReason.OperationFailed &&
    error.code === FAILED_CODE
  );
}

function checkoutOf(name: string, directory: string) {
  return { binding_id: createIdentity("binding"), name, directory, head: "" };
}

test("a failed coder report submit stops with the code of the port answer", async (t) => {
  const h = harness(t, failedSubmit());
  await assert.rejects(
    reportCoder.run(
      {
        claim: h.claim,
        state: { checkouts: [checkoutOf("app", "app")] } as StepsState,
        reports: new Map([["unit", "text"]]),
      },
      null,
      h.io,
    ),
    isFailedStop,
  );
});

test("a failed head commit submit stops with the code of the port answer", async (t) => {
  const h = harness(t, failedSubmit());
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  await git.raw([...COMMIT_IDENTITY, "commit", "--allow-empty", "-m", "head"]);
  await assert.rejects(
    evidenceHead.run(
      {
        claim: h.claim,
        state: {
          checkouts: [checkoutOf("app", directory)],
          input: { env: hostEnvironment() },
        } as StepsState,
      },
      null,
      h.io,
    ),
    isFailedStop,
  );
});

test("a failed base fetch stops with the code of the port answer", async (t) => {
  const h = harness(t, {
    repository: { fetchBase: async () => FAILED },
  });
  await assert.rejects(
    baseFetch.run(
      {
        state: {
          checkouts: [checkoutOf("app", "app")],
          agent: { budget: h.budget },
          run: h.run,
          input: { claim: h.claim },
        } as unknown as StepsState,
      },
      null,
      h.io,
    ),
    isFailedStop,
  );
});

test("a failed release tree take stops with the code of the port answer and gives back each taken tree", async (t) => {
  const root = temporary(t);
  const first = checkoutOf("app", join(root, "app"));
  const taken: CommandTree = {
    binding_id: first.binding_id,
    directory: join(root, "release", "app"),
    source: TreeSource.Clone,
  };
  const given: CommandTree[] = [];
  const h = harness(t, {
    releaseTrees: {
      take: async (checkout) =>
        checkout === first ? { kind: PortResultKind.Ok, value: taken } : FAILED,
      takeBase: async () => FAILED,
      give: async (tree) => void given.push(tree),
    },
  });
  await assert.rejects(
    releaseVerify.run(
      {
        state: {
          checkouts: [first, checkoutOf("lib", join(root, "lib"))],
          agent: { budget: h.budget },
          run: h.run,
          input: {
            claim: h.claim,
            workspaces: { nodeKey: () => root },
          },
          revision: {
            filename: "node.md",
            content: { verifications: ["true"] },
            tasks: [],
          },
        } as unknown as StepsState,
      },
      null,
      h.io,
    ),
    isFailedStop,
  );
  assert.deepEqual(given, [taken]);
});
