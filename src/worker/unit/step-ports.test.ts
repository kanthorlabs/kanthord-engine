import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { CauseCategory, unattributed } from "../../kernel/cause.ts";
import { background } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { createIdentity } from "../../kernel/identity.ts";
import {
  hostEnvironment,
  stopAfter,
  temporary,
} from "../../kernel/test-support.ts";
import {
  RepositoryErrorCode,
  type SshAccess,
} from "../../repository/contract.ts";
import { ExecutionBudget } from "./budget.ts";
import { type FoundryIo, StepKind } from "./chain.ts";
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
import { fetchAtRelease } from "./base-refresh.ts";
import { releaseVerify } from "./step-release-verify.ts";
import type { StepsInput, StepsState } from "./steps-implement.ts";
import { TreeSource } from "./tree-pool.ts";
import type { WorkspaceRoot } from "./workspace.ts";
import { workerPorts } from "./worker-ports.ts";

const WALL_TIME_MS = 60000;
const FAILED_CODE = "repository.connector.git_failed";
const FAILED: PortResult<never> = {
  kind: PortResultKind.Failed,
  code: FAILED_CODE,
  message: FAILED_CODE,
};
const RUN_SECRET = "run-secret-value";

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
    secrets: async () => [RUN_SECRET],
  });
  stopAfter(t, () => run.dispose());
  const budget = new ExecutionBudget({
    ...claim,
    resource_budget: { wall_time_ms: WALL_TIME_MS },
  });
  const io = {
    budget,
    context: run.operationContext,
    deadline: budget.wallDeadline(),
    ports: { log: { log: () => {} }, ...ports } as ImplementPorts,
  } satisfies FoundryIo<ImplementPorts>;
  return { claim, run, budget, io };
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
      giveBase: async () => assert.fail("The release takes no base tree."),
    },
  });
  const result = await releaseVerify.run(
    {
      state: {
        checkouts: [first, checkoutOf("lib", join(root, "lib"))],
        agent: { budget: h.budget },
        cancel: h.run.operationContext,
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
  );
  assert.ok(result.kind === StepKind.Stop && isFailedStop(result.stop));
  assert.deepEqual(given, [taken]);
});

test("a base fetch that git refuses stops with the redacted git detail and the fetch cause", async (t) => {
  const h = harness(t, {});
  const checkout = checkoutOf("app", temporary(t));
  const input = {
    claim: h.claim,
    setup: {
      repositories: [
        {
          binding_id: checkout.binding_id,
          name: checkout.name,
          address: "git@example.invalid:app.git",
          strategy: { base_branch: "main" },
        },
      ],
    },
    workspaces: { nodeKey: () => temporary(t) } as unknown as WorkspaceRoot,
    transport: {
      fetchBase: async () => {
        throw new Diagnostic(RepositoryErrorCode.GitFailed, "fetch failed.", {
          cause: new Error(`fetch: rejected ${RUN_SECRET}`),
        });
      },
    },
    sshAccess: new Map([[checkout.binding_id, {} as SshAccess]]),
    env: hostEnvironment(),
  } as unknown as StepsInput;
  await assert.rejects(
    fetchAtRelease(
      {
        checkouts: [checkout],
        agent: { budget: h.budget },
        cancel: h.run.operationContext,
        input,
      } as unknown as StepsState,
      workerPorts(input, h.run),
    ),
    (error) => {
      assert.ok(error instanceof ExecutionStop);
      assert.deepEqual(
        {
          reason: error.reason,
          code: error.code,
          detail: error.detail,
          cause: error.cause,
        },
        {
          reason: EndReason.OperationFailed,
          code: RepositoryErrorCode.GitFailed,
          detail: "Error: fetch: rejected [redacted]",
          cause: unattributed([
            CauseCategory.Infrastructure,
            CauseCategory.WorkerAction,
          ]),
        },
      );
      return true;
    },
  );
});
