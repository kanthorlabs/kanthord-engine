import assert from "node:assert/strict";
import { PromptTemplate } from "../../agent/contract.ts";
import { test, type TestContext } from "node:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  hostEnvironment,
  stopAfter,
  temporary,
} from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import {
  background,
  type CancellationContext,
  DeadlineExceeded,
} from "../../kernel/context.ts";
import { ExecutionBudget } from "./budget.ts";
import { EndReason, ExecutionRun, ExecutionStop } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import { ExecutionIntent } from "../contract.ts";
import {
  affectedCommand,
  anthropicSetup,
  everyBindingSshAccess,
  transport as localTransport,
  repositorySetup,
} from "./test-support.ts";
import { WorkspaceRoot } from "./workspace.ts";
import { AFFECTED_DECLARATION_FILE, AffectedVerdict } from "./affected.ts";
import type { MethodClients } from "./method-clients.ts";
import type { RepositoryTransport } from "../contract.ts";
import type { NativeAgent } from "./native-agent.ts";
import type { WorkPrompt } from "../../agent/prompt-composer.ts";
import {
  requestAndRelease,
  runEvaluation,
  setupFailureAssessment,
} from "./evaluation.ts";
import { SetupEnd } from "./environment-setup.ts";
import { VerificationClass } from "./verification.ts";
import { ActionResultKind } from "../contract.ts";
import {
  AssessmentResult,
  AssetKind,
  INLINE_BYTES_MAX,
  type ReviewRound,
} from "../../mission/contract.ts";
import {
  ROUND_PATCH_MEDIA_TYPE,
  ROUND_PATCH_SUBJECT,
  roundPatchContent,
} from "./round-patch.ts";
import { RecordKind, type TelemetryRecord } from "../../tracking/contract.ts";
import {
  CauseAssigner,
  CauseCategory,
  CauseSubcategory,
  unattributed,
} from "../../kernel/cause.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { simpleGit } from "simple-git";
import { SpanOperation } from "./telemetry.ts";
import { EvaluationAttribute } from "./method-telemetry.ts";
import { EvaluationStage } from "./evaluation.ts";
import { JUDGEMENT_MARKER, repairInstruction } from "./judgement.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import { VERIFICATION_INFRASTRUCTURE_FAILED } from "./verification.ts";

const NO_RELEASES = 0;
const SINGLE_RELEASE = 1;
const SINGLE_BINDING = 1;
const NO_BINDINGS = 0;
const SECOND_ROUND = 2;
const TWO_PATCHES = 2;
const GATEWAY_BODY_LIMIT_BYTES = 10 * 1024 * 1024;
const FIRST_ROUND = {
  round: 1,
  final: false,
  review_base: null,
  findings: [],
};
const PROPOSAL = {
  dependency_id: "child",
  name: "Fix the defect",
  requirement: "Repair the defect",
  criterion: "The defect is gone",
  task: {
    name: "Repair",
    requirement: "Change the code",
    criterion: "The test passes",
    verifications: ["npm test"],
  },
};
const STATED_FINDING = {
  label: "B1",
  action: "yes",
  task_id: null,
  ground: "stated",
  name: "Defect",
  description: "the defect",
  fix: "Repair it",
  why: "The criterion fails",
};
const PROPOSAL_REPLY = `kanthord-judgement: ${JSON.stringify({
  result: "criterion-not-met",
  rationale: "defect in child",
  proposals: [PROPOSAL],
})}`;
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
      node_branch: `kanthord/${"node"}`,
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      trace_id: "trace",
      root_span_id: "1".repeat(16),
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
    stopAfter(t, () => run.dispose());
    const accepted = kinds.every(
      (kind) =>
        kind === ActionResultKind.Submitted ||
        kind === ActionResultKind.AwaitingPrerequisite,
    );
    const stop = {
      reason: EndReason.ActionUnsettled,
      code: null,
      cause: unattributed([
        CauseCategory.WorkerAction,
        CauseCategory.Infrastructure,
      ]),
    };
    if (accepted) {
      assert.deepEqual(await requestAndRelease(run), {
        kind: "released",
        furtherWork: false,
      });
      assert.deepEqual(releases, [{ further_work: false, stop: null }]);
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
        `kanthord-judgement: ${JSON.stringify({ result: "criterion-not-met", rationale: "unmet", findings: [STATED_FINDING] })}`,
      ],
      result: "criterion-not-met",
      opens: 1,
      reworked: true,
    },
    {
      command: "true",
      texts: [
        `kanthord-judgement: ${JSON.stringify({ result: "criterion-not-met", rationale: "unmet", findings: [STATED_FINDING] })}`,
      ],
      result: "criterion-not-met",
      opens: 1,
      reworked: true,
      reworkedState: "Pending",
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
      examine: true,
    },
    {
      command: "true",
      texts: [PROPOSAL_REPLY],
      result: "undetermined",
      opens: 1,
      examine: true,
      proposals: [PROPOSAL],
    },
    {
      command: "true",
      texts: [
        `kanthord-judgement: ${JSON.stringify({ result: "success", rationale: "met", proposals: [PROPOSAL] })}`,
      ],
      result: "success",
      opens: 1,
    },
    { command: "true", texts: [""], result: null, opens: 0, refused: true },
  ]) {
    const repository = repositorySetup();
    const setup = anthropicSetup({
      intent: scenario.examine
        ? ExecutionIntent.Examine
        : ExecutionIntent.Implement,
      repositories: scenario.examine ? [] : [repository],
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
    const templates: PromptTemplate[] = [];
    let reported = false;
    const clients = {
      mission: {
        "execution.review_round.get": async () => complete(FIRST_ROUND),
        "execution.pinnedRevision.get": async () =>
          complete({
            content: {
              name: "node",
              requirement: "work",
              criterion: "met",
              verifications: [scenario.command],
              bindings: scenario.examine ? [] : [repository.binding_id],
            },
            tasks: [],
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
        "execution.dependency.list": async () =>
          complete({
            items: [{ id: "child", state: "Completed" }],
            next_cursor: null,
          }),
        "execution.dependency.outcome.list": async () =>
          complete({
            items: [
              { id: "child-outcome", result: "success", node_id: "child" },
            ],
            next_cursor: null,
          }),
        "execution.dependency.evidence.list": async () =>
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
            dependency_outcome_ids: string[];
            rationale: string;
            proposals?: unknown[];
          };
        }) => {
          assessments++;
          assert.deepEqual(
            input.body.proposals ?? [],
            scenario.proposals ?? [],
          );
          assert.ok(reported);
          assert.equal(input.body.result, scenario.result);
          assert.deepEqual(input.body.evidence_ids, ["verification", "placed"]);
          assert.deepEqual(
            input.body.dependency_outcome_ids,
            scenario.examine ? ["child-outcome"] : [],
          );
          if (!scenario.opens)
            assert.match(input.body.rationale, /Verification 1 `false` failed/);
          if (scenario.reworked)
            return complete({
              assessment: { result: scenario.result },
              node: { state: scenario.reworkedState ?? "Available" },
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
    stopAfter(t, () => run.dispose());
    const workspaces = WorkspaceRoot.open(temporary(t));
    const open = async () => {
      opens++;
      return {
        budget: {
          exhausted: () =>
            scenario.budgetEndsOnRepair === true &&
            instructions.at(-1) ===
              repairInstruction(SHIPPED_TEMPLATES, JUDGEMENT_MARKER),
        },
        instruct: async (
          _work: WorkPrompt,
          instruction: string,
          template: PromptTemplate,
        ) => {
          instructions.push(instruction);
          templates.push(template);
          if (
            instruction ===
            repairInstruction(SHIPPED_TEMPLATES, JUDGEMENT_MARKER)
          )
            return;
          assert.ok(instruction.includes(assetId));
          if (scenario.examine) {
            assert.match(instruction, /child-outcome/);
            assert.match(instruction, /Completed/);
            assert.match(instruction, /proposals replace criterion-not-met/);
          } else assert.doesNotMatch(instruction, /dependency_id/);
        },
        lastText: () =>
          scenario.texts[
            Math.min(instructions.length, scenario.texts.length) - 1
          ],
      } as unknown as NativeAgent;
    };
    const pending = runEvaluation(
      {
        setup,
        claim,
        workspaces,
        transport: {} as RepositoryTransport,
        sshAccess: everyBindingSshAccess,
        env: hostEnvironment(),
      },
      run,
      new ExecutionBudget({
        ...claim,
        resource_budget: setup.resource_budget,
      }),
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
    if (instructions.length > NO_RELEASES)
      assert.equal(templates[0], PromptTemplate.Evaluation);
    assert.equal(
      templates.at(-1) === PromptTemplate.Repair,
      scenario.repaired === true,
    );
    assert.equal(
      instructions.at(-1) ===
        repairInstruction(SHIPPED_TEMPLATES, JUDGEMENT_MARKER),
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

test("an evaluation that its agent deadline cuts ends with no assessment and no operation failure", async (t) => {
  const repository = repositorySetup();
  const setup = anthropicSetup({ repositories: [repository] });
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
  const assetId = createIdentity("evidence_asset");
  const address = { kind: "produced", sha256: "a".repeat(64) };
  const complete = (data: unknown) => ({
    type: "completed",
    status: 200,
    data,
  });
  let assessments = 0;
  const releases: unknown[] = [];
  const clients = {
    mission: {
      "execution.review_round.get": async () => complete(FIRST_ROUND),
      "execution.pinnedRevision.get": async () =>
        complete({
          content: {
            name: "node",
            requirement: "work",
            criterion: "met",
            verifications: ["true"],
            bindings: [repository.binding_id],
          },
          tasks: [],
        }),
      "execution.evidence.list": async () =>
        complete({
          items: [
            {
              id: "placed",
              assets: [{ id: assetId, kind: "produced", address }],
            },
          ],
          next_cursor: null,
        }),
      "execution.evidence.asset.content.get": async () =>
        complete({
          asset_id: assetId,
          address,
          data: Buffer.from("report").toString("base64"),
          encoding: "base64",
          media_type: "text/markdown",
        }),
      "evidence.submit": async () =>
        complete({ evidence: { id: "verification" } }),
      "assessment.submit": async () => {
        assessments++;
        return complete({ outcome: { id: "outcome" } });
      },
    },
    scheduler: {
      executionRelease: async (input: { body: unknown }) => {
        releases.push(input.body);
        return complete({});
      },
    },
  } as unknown as MethodClients;
  const run = new ExecutionRun({
    claim,
    clients,
    credentials: { release: async () => {} },
    context: background,
  });
  stopAfter(t, () => run.dispose());
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
        context!.signal.throwIfAborted();
      },
      lastText: () => undefined,
    } as unknown as NativeAgent;
  };
  const workspaces = WorkspaceRoot.open(temporary(t));
  await executionBoundary(run, () =>
    runEvaluation(
      {
        setup,
        claim,
        workspaces,
        transport: {} as RepositoryTransport,
        sshAccess: everyBindingSshAccess,
        env: hostEnvironment(),
      },
      run,
      budget,
      open,
    ),
  );
  assert.equal(assessments, NO_RELEASES);
  assert.deepEqual(releases, [
    {
      further_work: true,
      stop: {
        reason: EndReason.AssessmentAbsent,
        code: null,
        cause: unattributed([CauseCategory.Plan, CauseCategory.Model]),
      },
    },
  ]);
});

const TASK_ID = createIdentity("task");

interface Submitted {
  subject: string;
  verification?: unknown;
  requirement_key?: unknown;
  assets: {
    kind: string;
    content: { media_type: string; encoding: string; data: string };
  }[];
}

interface ReviewOptions {
  reply?: string;
  repository?: ReturnType<typeof repositorySetup>;
  snapshot?: string;
  bindings?: {
    repository: ReturnType<typeof repositorySetup>;
    snapshot: string;
  }[];
  taskCommand?: string;
  transport?: RepositoryTransport;
  round?: ReviewRound;
  answer?: unknown;
}

async function reviewOf(
  t: TestContext,
  command: string,
  wallTimeMs?: number,
  options: ReviewOptions = {},
) {
  const repository =
    options.bindings?.[0]?.repository ??
    options.repository ??
    repositorySetup();
  const bindings =
    options.bindings ??
    (options.snapshot === undefined
      ? []
      : [{ repository, snapshot: options.snapshot }]);
  const repositories = options.bindings?.map((entry) => entry.repository) ?? [
    repository,
  ];
  const setup = anthropicSetup({ repositories });
  if (wallTimeMs !== undefined) setup.resource_budget.wall_time_ms = wallTimeMs;
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
  const assetId = createIdentity("evidence_asset");
  const address = { kind: "produced", sha256: "a".repeat(64) };
  const complete = (data: unknown) => ({
    type: "completed",
    status: 200,
    data,
  });
  const assessments: {
    result: string;
    rationale: string;
    evidence_ids: string[];
    cause?: unknown;
    findings: unknown[];
    fixed_finding_ids: string[];
  }[] = [];
  const records: TelemetryRecord[] = [];
  const verifications: { results: { exit_code: number | null }[] }[] = [];
  const submits: Submitted[] = [];
  const instructions: string[] = [];
  const releases: unknown[] = [];
  const actionRequests: unknown[] = [];
  const clients = {
    worker: {
      "action.request": async (input: unknown) => {
        actionRequests.push(input);
        return complete({ items: [] });
      },
    },
    mission: {
      "execution.review_round.get": async () =>
        complete(options.round ?? FIRST_ROUND),
      "execution.pinnedRevision.get": async () =>
        complete({
          content: {
            name: "node",
            requirement: "work",
            criterion: "met",
            verifications: [command],
            bindings: repositories.map((entry) => entry.binding_id),
          },
          tasks:
            options.taskCommand === undefined
              ? []
              : [
                  {
                    id: TASK_ID,
                    filename: "task.md",
                    content: {
                      name: "task",
                      requirement: "work",
                      criterion: "met",
                      verifications: [options.taskCommand],
                      bindings: [repository.binding_id],
                    },
                  },
                ],
        }),
      "execution.evidence.list": async () =>
        complete({
          items: [
            {
              id: "placed",
              assets: [{ id: assetId, kind: "produced", address }],
            },
            ...(bindings.length === NO_BINDINGS
              ? []
              : [
                  {
                    id: "snapshot",
                    assets: bindings.map((entry) => ({
                      id: createIdentity("evidence_asset"),
                      kind: "repository",
                      address: {
                        kind: "repository",
                        binding_id: entry.repository.binding_id,
                        commit: entry.snapshot,
                      },
                    })),
                  },
                ]),
          ],
          next_cursor: null,
        }),
      "execution.evidence.asset.content.get": async () =>
        complete({
          asset_id: assetId,
          address,
          data: Buffer.from("report").toString("base64"),
          encoding: "base64",
          media_type: "text/markdown",
        }),
      "evidence.submit": async (input: {
        body: Submitted & { verification?: (typeof verifications)[number] };
      }) => {
        submits.push(input.body);
        if (input.body.subject === ROUND_PATCH_SUBJECT)
          return complete({ evidence: { id: `patch_${submits.length}` } });
        if (!input.body.verification)
          return complete({ evidence: { id: "affected" } });
        verifications.push(input.body.verification);
        return complete({ evidence: { id: "verification" } });
      },
      "assessment.submit": async (input: {
        body: (typeof assessments)[number];
      }) => {
        assessments.push(input.body);
        return complete(options.answer ?? { outcome: { id: "outcome" } });
      },
    },
    scheduler: {
      executionRelease: async (input: { body: unknown }) => {
        releases.push(input.body);
        return complete({});
      },
    },
  } as unknown as MethodClients;
  const run = new ExecutionRun({
    claim,
    clients,
    credentials: { release: async () => {} },
    context: background,
    telemetry: {
      write: (batch) => records.push(...batch),
      flush: async () => {},
    },
  });
  stopAfter(t, () => run.dispose());
  const budget = new ExecutionBudget({
    ...claim,
    resource_budget: setup.resource_budget,
  });
  let opens = 0;
  const open = async () => {
    opens++;
    return {
      budget,
      instruct: async (_work: WorkPrompt, instruction: string) => {
        instructions.push(instruction);
      },
      lastText: () =>
        options.reply ??
        'kanthord-judgement: {"result":"success","rationale":"met"}',
    } as unknown as NativeAgent;
  };
  const end = await executionBoundary(run, () =>
    runEvaluation(
      {
        setup,
        claim,
        workspaces: WorkspaceRoot.open(temporary(t)),
        transport: options.transport ?? ({} as RepositoryTransport),
        sshAccess: everyBindingSshAccess,
        env: hostEnvironment(),
      },
      run,
      budget,
      open,
    ),
  );
  return {
    nodeId: claim.node_id,
    end,
    assessments,
    verifications,
    submits,
    instructions,
    releases,
    records,
    actionRequests,
    opens: () => opens,
  };
}

const SIGNAL_KILL = "sh -c 'kill -9 $$'";
const EXIT_KILL = "sh -c 'kill -9 $$'; exit $?";
const PASSED = 0;
const NO_OPENS = 0;
const ONE_OPEN = 1;
const SHORT_WALL_TIME_MS = 2000;

test("a persistent kill in a review verification stops with the infrastructure code and no assessment", async (t) => {
  for (const command of [SIGNAL_KILL, EXIT_KILL]) {
    const review = await reviewOf(t, command);
    assert.deepEqual(review.assessments, []);
    assert.equal(review.opens(), NO_OPENS);
    assert.equal(review.releases.length, SINGLE_RELEASE);
    const [body] = review.releases as {
      further_work: boolean;
      stop: { reason: string; code: string; detail: string };
    }[];
    assert.equal(body?.further_work, true);
    assert.equal(body?.stop.reason, EndReason.OperationFailed);
    assert.equal(body?.stop.code, VERIFICATION_INFRASTRUCTURE_FAILED);
    assert.ok(body?.stop.detail.includes(command));
  }
});

test("a kill on the first review run and a pass on the rerun is a pass and not flaky", async (t) => {
  const marker = join(temporary(t), "killed");
  const review = await reviewOf(
    t,
    `test -f ${marker} || { touch ${marker}; kill -9 $$; }`,
  );
  assert.deepEqual(review.end, { kind: "closed", outcomeId: "outcome" });
  assert.equal(review.opens(), ONE_OPEN);
  assert.deepEqual(
    review.verifications.map((verification) =>
      verification.results.map((result) => result.exit_code),
    ),
    [[PASSED]],
  );
  assert.equal(review.assessments.length, SINGLE_RELEASE);
  assert.equal(review.assessments[0]?.result, AssessmentResult.Success);
  assert.doesNotMatch(review.assessments[0]?.rationale ?? "", /flaky/);
});

test("exit 127 in a review verification stays criterion-not-met", async (t) => {
  const review = await reviewOf(t, "command-absent-x");
  assert.equal(review.opens(), NO_OPENS);
  assert.equal(review.assessments[0]?.result, AssessmentResult.CriterionNotMet);
  assert.deepEqual(review.releases, []);
});

test("a wall deadline during a review verification ends with no assessment and the suspects environment, plan and model", async (t) => {
  const review = await reviewOf(t, "sleep 30", SHORT_WALL_TIME_MS);
  assert.deepEqual(review.assessments, []);
  assert.deepEqual(review.releases, [
    {
      further_work: true,
      stop: {
        reason: EndReason.AssessmentAbsent,
        code: null,
        cause: unattributed([
          CauseCategory.Environment,
          CauseCategory.Plan,
          CauseCategory.Model,
        ]),
      },
    },
  ]);
});

test("a node-head setup failure of a review is criterion-not-met and names the setup command", () => {
  assert.equal(setupFailureAssessment(null), null);
  const command = "npm ci";
  const assessment = setupFailureAssessment({
    end: SetupEnd.Failed,
    commands: [command],
    run: {
      verification: {
        tested_input: { kind: "produced", sha256: "a".repeat(64) },
        results: [
          {
            command,
            exit_code: 1,
            signal: null,
            timed_out: false,
          },
        ],
      },
      outputs: ["npm ERR! missing lockfile"],
      flaky: [false],
      outcome: VerificationClass.CodeFailure,
    },
  });
  assert.equal(assessment?.result, AssessmentResult.CriterionNotMet);
  assert.match(assessment?.rationale ?? "", /Verification 1 `npm ci` failed/);
  assert.deepEqual(assessment?.proposals, []);
});

function verificationStarts(records: readonly TelemetryRecord[]) {
  return records.flatMap((record) =>
    record.kind === RecordKind.Span &&
    record.operation === SpanOperation.Verification &&
    record.start_time !== undefined
      ? [record.attributes]
      : [],
  );
}

test("the verification spans of a review name the owner of each command with the context evaluation", async (t) => {
  const review = await reviewOf(t, "true", undefined, {
    taskCommand: "true && true",
  });
  assert.deepEqual(
    verificationStarts(review.records).map((attributes) => [
      attributes?.["kanthord.verification.context"],
      attributes?.["kanthord.verification.owner_id"],
    ]),
    [
      ["evaluation", review.nodeId],
      ["evaluation", TASK_ID],
    ],
  );
});

test("a command that the node and a task share runs once at the evaluation and the evidence holds two results", async (t) => {
  const count = join(temporary(t), "count");
  const shared = `echo x >> ${count}`;
  const review = await reviewOf(t, shared, undefined, { taskCommand: shared });
  assert.equal(
    readFileSync(count, "utf8").trim().split("\n").length,
    SINGLE_RELEASE,
  );
  assert.deepEqual(
    verificationStarts(review.records).map((attributes) => [
      attributes?.["kanthord.verification.context"],
      attributes?.["kanthord.verification.owner_id"],
    ]),
    [["evaluation", review.nodeId]],
  );
  assert.deepEqual(
    review.verifications[0]?.results.map((result) => result.exit_code),
    [PASSED, PASSED],
  );
});

const STATED_REPLY = `kanthord-judgement: ${JSON.stringify({
  result: "criterion-not-met",
  rationale: "unmet",
  findings: [
    { ...STATED_FINDING, task_id: TASK_ID, description: "a" },
    { ...STATED_FINDING, label: "B2", ground: "standard", description: "b" },
    { ...STATED_FINDING, label: "S1", ground: null, description: "c" },
  ],
})}`;

function evaluationEndOf(records: readonly TelemetryRecord[]) {
  const ends = records.filter(
    (record) =>
      record.kind === RecordKind.Span &&
      record.operation === SpanOperation.Evaluation &&
      record.end_time !== undefined,
  );
  assert.equal(ends.length, SINGLE_RELEASE);
  return ends[0] as TelemetryRecord & { attributes: Record<string, unknown> };
}

test("a failed review verification submits the cause with the suspects model and plan", async (t) => {
  const review = await reviewOf(t, "false");
  assert.deepEqual(review.assessments[0]?.cause, {
    category: CauseCategory.Unattributed,
    assigner: CauseAssigner.Rule,
    suspects: [CauseCategory.Model, CauseCategory.Plan],
  });
  const attributes = evaluationEndOf(review.records).attributes;
  assert.equal(
    attributes[EvaluationAttribute.Stage],
    EvaluationStage.Verification,
  );
  assert.deepEqual(attributes[EvaluationAttribute.UnmetIds], []);
  assert.deepEqual(attributes[EvaluationAttribute.UnmetGrounds], []);
  assert.equal(attributes[EvaluationAttribute.ProposalCount], NO_RELEASES);
  assert.equal(EvaluationAttribute.Repaired in attributes, false);
});

test("a judgement with a stated first blocker submits the work defect cause and its facts", async (t) => {
  const review = await reviewOf(t, "true", undefined, {
    reply: STATED_REPLY,
    taskCommand: "true",
  });
  assert.deepEqual(review.assessments[0]?.cause, {
    category: CauseCategory.Model,
    subcategory: CauseSubcategory.WorkDefect,
    assigner: CauseAssigner.Reviewer,
  });
  const end = evaluationEndOf(review.records);
  assert.deepEqual(end.attributes, {
    [EvaluationAttribute.Result]: AssessmentResult.CriterionNotMet,
    [EvaluationAttribute.Stage]: EvaluationStage.Judgement,
    [EvaluationAttribute.UnmetIds]: [TASK_ID, review.nodeId],
    [EvaluationAttribute.UnmetGrounds]: ["stated", "standard"],
    [EvaluationAttribute.ProposalCount]: NO_RELEASES,
    [EvaluationAttribute.Repaired]: false,
    [EvaluationAttribute.Round]: 1,
    [EvaluationAttribute.FinalRound]: false,
    [EvaluationAttribute.ActionLabels]: ["B1", "B2", "S1"],
    [EvaluationAttribute.FixedCount]: NO_RELEASES,
  });
  assert.deepEqual(
    review.assessments[0]?.findings.map(
      (finding) => (finding as { label: string }).label,
    ),
    ["B1", "B2", "S1"],
  );
  assert.deepEqual(review.assessments[0]?.fixed_finding_ids, []);
  assert.equal(
    Object.keys(end.attributes).some((name) =>
      name.startsWith("kanthord.cause."),
    ),
    false,
  );
});

test("a success result submits no cause", async (t) => {
  const review = await reviewOf(t, "true");
  assert.equal(review.assessments[0]?.result, AssessmentResult.Success);
  assert.equal("cause" in (review.assessments[0] ?? {}), false);
  assert.equal(
    evaluationEndOf(review.records).attributes[EvaluationAttribute.Repaired],
    false,
  );
});

test("a failed node-head setup submits the cause with the suspects environment and model", async (t) => {
  const origin = join(temporary(t), "origin");
  mkdirSync(origin);
  const git = simpleGit(origin);
  await git.raw(["init", "-b", "main"]);
  writeFileSync(join(origin, "base"), "base");
  await git.add("base");
  const identity = [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=a@example.invalid",
  ];
  await git.raw([...identity, "commit", "-m", "base"]);
  await git.raw(["checkout", "-b", "node"]);
  writeFileSync(join(origin, "work"), "work");
  await git.add("work");
  await git.raw([...identity, "commit", "-m", "work"]);
  const snapshot = (await git.revparse(["HEAD"])).trim();
  await git.raw(["checkout", "main"]);
  const review = await reviewOf(t, "true", undefined, {
    repository: {
      ...repositorySetup(),
      address: origin,
      environment: {
        source: EnvironmentSource.Detected,
        document: { postCreateCommand: "test ! -e work" },
      },
    } as unknown as ReturnType<typeof repositorySetup>,
    snapshot,
    transport: localTransport,
  });
  assert.equal(review.opens(), NO_OPENS);
  assert.deepEqual(review.assessments[0]?.cause, {
    category: CauseCategory.Unattributed,
    assigner: CauseAssigner.Rule,
    suspects: [CauseCategory.Environment, CauseCategory.Model],
  });
  const attributes = evaluationEndOf(review.records).attributes;
  assert.equal(attributes[EvaluationAttribute.Stage], EvaluationStage.Setup);
});

const AFFECTED_SUBJECT_TEXT = "Affected test results";
const JSON_MEDIA_TYPE = "application/json";
const BASE64_ENCODING = "base64";
const REPOSITORY_NAME = "repo";
const BROKEN = "broken";
const FAILS_WHEN_BROKEN = `grep -q ${BROKEN} file`;
const GATE_FILES_KEY = "gate_files";
const COMMIT_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=a@example.invalid",
];

async function affectedSnapshot(
  t: TestContext,
  declaredCommand: string | null,
  nodeContent: string,
) {
  const origin = join(temporary(t), "origin");
  mkdirSync(origin);
  const git = simpleGit(origin);
  await git.raw(["init", "-b", "main"]);
  writeFileSync(join(origin, "file"), "base");
  await git.add("file");
  if (declaredCommand !== null) {
    mkdirSync(join(origin, dirname(AFFECTED_DECLARATION_FILE)));
    writeFileSync(
      join(origin, AFFECTED_DECLARATION_FILE),
      JSON.stringify({ version: 1, command: declaredCommand }),
    );
    await git.add(AFFECTED_DECLARATION_FILE);
  }
  await git.raw([...COMMIT_IDENTITY, "commit", "-m", "base"]);
  await git.raw(["checkout", "-b", "node"]);
  writeFileSync(join(origin, "file"), nodeContent);
  await git.add("file");
  await git.raw([...COMMIT_IDENTITY, "commit", "-m", "work"]);
  const snapshot = (await git.revparse(["HEAD"])).trim();
  await git.raw(["checkout", "main"]);
  return {
    repository: {
      ...repositorySetup(),
      address: origin,
    } as unknown as ReturnType<typeof repositorySetup>,
    snapshot,
    transport: localTransport,
  };
}

async function affectedReview(
  t: TestContext,
  declaredCommand: string | null,
  nodeContent: string,
  command = "true",
) {
  return reviewOf(t, command, undefined, {
    ...(await affectedSnapshot(t, declaredCommand, nodeContent)),
  });
}

function affectedEvidenceOf(review: Awaited<ReturnType<typeof reviewOf>>) {
  return review.submits.filter(
    (submit) => submit.subject === AFFECTED_SUBJECT_TEXT,
  );
}

function affectedLineOf(instruction: string | undefined) {
  const prefix = "Affected test results of this evaluation: ";
  const line = instruction?.split("\n").find((text) => text.startsWith(prefix));
  assert.ok(line);
  return JSON.parse(line.slice(prefix.length));
}

function affectedEnd(review: Awaited<ReturnType<typeof reviewOf>>) {
  return evaluationEndOf(review.records).attributes[
    EvaluationAttribute.Affected
  ];
}

test("a passing affected command submits its evidence, adds its id, informs the reviewer and ends the span with passed", async (t) => {
  const review = await affectedReview(t, affectedCommand("false"), "changed");
  assert.deepEqual(review.end, { kind: "closed", outcomeId: "outcome" });
  const [evidence, ...others] = affectedEvidenceOf(review);
  assert.equal(others.length, NO_RELEASES);
  assert.equal("verification" in evidence!, false);
  assert.equal("requirement_key" in evidence!, false);
  assert.equal(evidence?.assets.length, SINGLE_RELEASE);
  const [asset] = evidence!.assets;
  assert.equal(asset?.kind, AssetKind.Produced);
  assert.equal(asset?.content.media_type, JSON_MEDIA_TYPE);
  assert.equal(asset?.content.encoding, BASE64_ENCODING);
  const document = JSON.parse(
    Buffer.from(asset!.content.data, "base64").toString("utf8"),
  );
  assert.equal(document.verdict, AffectedVerdict.Passed);
  assert.equal(document.repositories[0].repository, REPOSITORY_NAME);
  assert.deepEqual(review.assessments[0]?.evidence_ids, [
    "verification",
    "affected",
    "snapshot",
    "placed",
  ]);
  assert.equal(review.opens(), ONE_OPEN);
  assert.deepEqual(affectedLineOf(review.instructions[0]), document);
  assert.equal(affectedEnd(review), AffectedVerdict.Passed);
});

test("an assessment submits no gate_files key", async (t) => {
  const review = await affectedReview(t, affectedCommand("false"), "changed");
  assert.equal(GATE_FILES_KEY in (review.assessments[0] ?? {}), false);
});

test("an affected test that fails at the head and passes at the base answers criterion-not-met with no agent turn", async (t) => {
  const review = await affectedReview(
    t,
    affectedCommand(`echo head-output; ${FAILS_WHEN_BROKEN}`),
    BROKEN,
  );
  assert.equal(review.opens(), NO_OPENS);
  assert.equal(review.instructions.length, NO_OPENS);
  const [assessment] = review.assessments;
  assert.equal(assessment?.result, AssessmentResult.CriterionNotMet);
  assert.match(
    assessment?.rationale ?? "",
    /^The affected test run of repository repo failed\./,
  );
  assert.match(
    assessment?.rationale ?? "",
    /1 test failed: a\.test\.ts > one\./,
  );
  assert.match(
    assessment?.rationale ?? "",
    /Output of the failed run \(the last 4 KiB\):\n\n```text\nhead-output\n\n```$/,
  );
  assert.deepEqual(assessment?.cause, {
    category: CauseCategory.Unattributed,
    assigner: CauseAssigner.Rule,
    suspects: [CauseCategory.Model, CauseCategory.Plan],
  });
  assert.deepEqual(assessment?.evidence_ids, [
    "verification",
    "affected",
    "snapshot",
    "placed",
  ]);
  const attributes = evaluationEndOf(review.records).attributes;
  assert.equal(attributes[EvaluationAttribute.Stage], EvaluationStage.Affected);
  assert.equal(
    attributes[EvaluationAttribute.Affected],
    AffectedVerdict.Failed,
  );
});

test("an affected test that fails at both heads goes to the reviewer with base_red", async (t) => {
  const review = await affectedReview(t, affectedCommand("true"), "changed");
  assert.equal(review.opens(), ONE_OPEN);
  assert.equal(review.assessments[0]?.result, AssessmentResult.Success);
  assert.equal(
    affectedLineOf(review.instructions[0]).verdict,
    AffectedVerdict.BaseRed,
  );
  assert.equal(affectedEnd(review), AffectedVerdict.BaseRed);
});

test("a node with no declaration submits no affected evidence and passes null to the reviewer", async (t) => {
  const review = await affectedReview(t, null, "changed");
  assert.equal(affectedEvidenceOf(review).length, NO_RELEASES);
  assert.deepEqual(review.assessments[0]?.evidence_ids, [
    "verification",
    "snapshot",
    "placed",
  ]);
  assert.equal(affectedLineOf(review.instructions[0]), null);
  assert.equal(affectedEnd(review), AffectedVerdict.Absent);
});

test("a failed listed command runs no affected command", async (t) => {
  const marker = join(temporary(t), "affected-ran");
  const review = await affectedReview(
    t,
    affectedCommand(`touch ${marker}; true`),
    "changed",
    "false",
  );
  assert.equal(existsSync(marker), false);
  assert.equal(affectedEvidenceOf(review).length, NO_RELEASES);
  assert.equal(review.assessments[0]?.result, AssessmentResult.CriterionNotMet);
  assert.equal(
    EvaluationAttribute.Affected in evaluationEndOf(review.records).attributes,
    false,
  );
});

async function roundSnapshot(t: TestContext, name: string, fixContent: string) {
  const origin = join(temporary(t), `${name}-origin`);
  mkdirSync(origin);
  const git = simpleGit(origin);
  await git.raw(["init", "-b", "main"]);
  const commit = async (file: string, content: string) => {
    writeFileSync(join(origin, file), content);
    await git.add(file);
    await git.raw([...COMMIT_IDENTITY, "commit", "-m", file]);
    return (await git.revparse(["HEAD"])).trim();
  };
  await commit("base", "base");
  await git.raw(["checkout", "-b", "node"]);
  const judged = await commit("work", "work");
  const snapshot = await commit("fix", fixContent);
  await git.raw(["checkout", "main"]);
  return {
    repository: {
      ...repositorySetup(),
      name,
      address: origin,
    } as unknown as ReturnType<typeof repositorySetup>,
    snapshot,
    judged,
  };
}

const PRIOR_BLOCKER_ID = createIdentity("finding");
const PRIOR_SUGGESTION_ID = createIdentity("finding");

function priorFinding(id: string, label: string) {
  const blocker = label.startsWith("B");
  return {
    id,
    node_id: "node",
    attempt: 1,
    round: 1,
    assessment_id: createIdentity("assessment"),
    source: "reviewer",
    label,
    kind: blocker ? "blocker" : "suggestion",
    action: "yes",
    task_id: null,
    ground: blocker ? "stated" : null,
    name: `name ${label}`,
    description: `defect ${label}`,
    fix: `fix ${label}`,
    why: `why ${label}`,
    route: "fix",
    status: "open",
    fixed_assessment_id: null,
    cause_owner: null,
    created_by: null,
    created_at: 0,
    decision: null,
    decision_reason: null,
    decided_by: null,
    decided_at: null,
  };
}

function secondRound(
  bindings: readonly { repository: { binding_id: string }; judged: string }[],
  final = false,
): ReviewRound {
  const base = bindings.map(({ repository, judged }) => ({
    kind: "repository" as const,
    binding_id: repository.binding_id,
    commit: judged,
  }));
  return {
    round: 2,
    final,
    review_base: base.length === SINGLE_BINDING ? base[0]! : base,
    findings: [
      priorFinding(PRIOR_BLOCKER_ID, "B1"),
      priorFinding(PRIOR_SUGGESTION_ID, "S1"),
    ],
  } as ReviewRound;
}

const ROUND_SUCCESS = `kanthord-judgement: ${JSON.stringify({
  result: "success",
  rationale: "fixed",
  findings: [{ ...STATED_FINDING, label: "S1", ground: null }],
  fixed_finding_ids: [PRIOR_BLOCKER_ID],
})}`;

function patchSubmits(review: Awaited<ReturnType<typeof reviewOf>>) {
  return review.submits.filter(
    (submit) => submit.subject === ROUND_PATCH_SUBJECT,
  );
}

test("a round with a review base submits one patch evidence and the findings with fixed_finding_ids", async (t) => {
  const binding = await roundSnapshot(t, REPOSITORY_NAME, "fixed");
  const review = await reviewOf(t, "true", undefined, {
    bindings: [binding],
    transport: localTransport,
    round: secondRound([binding], true),
    reply: ROUND_SUCCESS,
  });
  assert.deepEqual(review.end, { kind: "closed", outcomeId: "outcome" });
  const [patch, ...others] = patchSubmits(review);
  assert.equal(others.length, NO_RELEASES);
  assert.equal(patch?.assets.length, SINGLE_RELEASE);
  assert.equal(patch?.assets[0]?.kind, AssetKind.Produced);
  assert.equal(patch?.assets[0]?.content.media_type, ROUND_PATCH_MEDIA_TYPE);
  const text = Buffer.from(patch!.assets[0]!.content.data, "base64").toString(
    "utf8",
  );
  assert.match(text, /\+\+\+ b\/fix/);
  assert.doesNotMatch(text, /b\/work/);
  const [assessment] = review.assessments;
  const patchId = `patch_${review.submits.indexOf(patch!) + 1}`;
  assert.deepEqual(assessment?.evidence_ids, [
    "verification",
    patchId,
    "snapshot",
    "placed",
  ]);
  assert.deepEqual(assessment?.findings, [
    { ...STATED_FINDING, label: "S1", ground: null },
  ]);
  assert.deepEqual(assessment?.fixed_finding_ids, [PRIOR_BLOCKER_ID]);
  assert.match(review.instructions[0]!, /^This is review round 2\./m);
  assert.ok(review.instructions[0]!.includes(PRIOR_SUGGESTION_ID));
  const bundle = JSON.parse(
    review.instructions[0]!.split("\n")
      .find((line) => line.startsWith("Evidence: "))!
      .slice("Evidence: ".length),
  );
  assert.deepEqual(bundle.patch_paths, [
    join("..", "..", "evidence", `round-2-${REPOSITORY_NAME}.patch`),
  ]);
  assert.deepEqual(bundle.changed_files, ["fix"]);
  const attributes = evaluationEndOf(review.records).attributes;
  assert.equal(attributes[EvaluationAttribute.Round], SECOND_ROUND);
  assert.equal(attributes[EvaluationAttribute.FinalRound], true);
  assert.deepEqual(attributes[EvaluationAttribute.ActionLabels], ["S1"]);
  assert.equal(attributes[EvaluationAttribute.FixedCount], SINGLE_RELEASE);
  assert.deepEqual(attributes[EvaluationAttribute.UnmetIds], []);
});

test("two bindings with patches over 5 MiB submit two patch evidences, each under the body limit", async (t) => {
  const large = "x"
    .repeat(1023)
    .concat("\n")
    .repeat(6 * 1024);
  const api = await roundSnapshot(t, "api", large);
  const web = await roundSnapshot(t, "web", large);
  const review = await reviewOf(t, "true", undefined, {
    bindings: [api, web],
    transport: localTransport,
    round: secondRound([api, web]),
    reply: ROUND_SUCCESS,
  });
  const patches = patchSubmits(review);
  assert.equal(patches.length, TWO_PATCHES);
  for (const patch of patches) {
    const asset = patch.assets[0]!;
    const bytes = Buffer.from(asset.content.data, "base64");
    assert.ok(bytes.length <= INLINE_BYTES_MAX);
    assert.match(
      bytes.toString("utf8"),
      /\n\[The patch exceeds 5 MiB and ends here\.\]\n$/,
    );
    assert.equal(bytes.toString("base64"), asset.content.data);
    assert.ok(
      Buffer.byteLength(JSON.stringify(patch), "utf8") <
        GATEWAY_BODY_LIMIT_BYTES,
    );
  }
  assert.equal(
    review.assessments[0]?.evidence_ids.filter((id) => id.startsWith("patch_"))
      .length,
    TWO_PATCHES,
  );
});

test("a cut patch with its trailer line holds at most INLINE_BYTES_MAX bytes, and the Mission Service accepts it", () => {
  const exact = "a".repeat(INLINE_BYTES_MAX);
  assert.equal(roundPatchContent(exact).toString("utf8"), exact);
  for (const patch of [
    "a".repeat(INLINE_BYTES_MAX + 1),
    "é".repeat(INLINE_BYTES_MAX),
  ]) {
    const content = roundPatchContent(patch);
    assert.ok(content.length <= INLINE_BYTES_MAX);
    assert.ok(content.length > INLINE_BYTES_MAX - 64);
    const text = content.toString("utf8");
    assert.equal(text.includes("�"), false);
    assert.match(text, /\n\[The patch exceeds 5 MiB and ends here\.\]\n$/);
    assert.ok(patch.startsWith(text.slice(0, text.lastIndexOf("\n["))));
    assert.equal(
      Buffer.from(content.toString("base64"), "base64").length,
      content.length,
    );
  }
});

test("a success answer with the node no longer Evaluating ends revoked with no request", async (t) => {
  const review = await reviewOf(t, "true", undefined, {
    answer: {
      assessment: { result: AssessmentResult.Success },
      node: { state: "Available" },
      outcome: null,
    },
  });
  assert.deepEqual(review.end, {
    kind: "ended",
    reason: EndReason.Revoked,
    code: null,
  });
  assert.deepEqual(review.actionRequests, []);
  assert.deepEqual(review.releases, []);
});

test("a success answer with the node still Evaluating requests the actions", async (t) => {
  const review = await reviewOf(t, "true", undefined, {
    answer: {
      assessment: { result: AssessmentResult.Success },
      node: { state: "Evaluating" },
      outcome: null,
    },
  });
  assert.deepEqual(review.end, { kind: "released", furtherWork: false });
  assert.equal(review.actionRequests.length, SINGLE_RELEASE);
});

test("a verification failure submits no finding, also with prior findings", async (t) => {
  const review = await reviewOf(t, "false", undefined, {
    round: {
      ...FIRST_ROUND,
      round: 2,
      findings: [priorFinding(PRIOR_BLOCKER_ID, "B1")],
    } as ReviewRound,
  });
  assert.equal(review.opens(), NO_OPENS);
  assert.equal(review.assessments[0]?.result, AssessmentResult.CriterionNotMet);
  assert.deepEqual(review.assessments[0]?.findings, []);
  assert.deepEqual(review.assessments[0]?.fixed_finding_ids, []);
  const attributes = evaluationEndOf(review.records).attributes;
  assert.equal(attributes[EvaluationAttribute.Round], SECOND_ROUND);
  assert.deepEqual(attributes[EvaluationAttribute.ActionLabels], []);
  assert.equal(attributes[EvaluationAttribute.FixedCount], NO_RELEASES);
});
