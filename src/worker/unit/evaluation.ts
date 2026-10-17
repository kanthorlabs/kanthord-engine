import assert from "node:assert/strict";
import { canonicalJSON } from "../../kernel/json.ts";
import {
  AssessmentResult,
  NodeState,
  type Revision,
} from "../../mission/contract.ts";
import type { ExecutionBudget } from "./budget.ts";
import { ContextCancelled, DeadlineExceeded } from "../../kernel/context.ts";
import {
  EndReason,
  ExecutionEndKind,
  type ExecutionEnd,
  type ExecutionRun,
} from "./execution-run.ts";
import {
  readAttemptEvidence,
  readDependencies,
  readPinnedRevision,
} from "./node-reads.ts";
import type { NativeAgent } from "./native-agent.ts";
import { prepareEvaluation, verificationCommands } from "./evaluation-input.ts";
import {
  runVerificationsWithOutput,
  verificationPassed,
  type VerificationRun,
} from "./verification.ts";
import {
  evaluationInstruction,
  evaluationJudgementSchema,
  judgementRationale,
  failedVerificationReport,
  parseRepaired,
  ReplyRepair,
} from "./judgement.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import type { StepsInput } from "./steps-implement.ts";
import {
  WorkspaceKind,
  workRepositoriesOf,
  type ExamineCheckout,
} from "./workspace.ts";
import { ActionResultKind, ExecutionWork } from "../contract.ts";
import {
  evaluationEnd,
  evaluationSpan,
  testedCommitOf,
  verificationObserver,
} from "./method-telemetry.ts";

export const ACCEPTED_ITEM_KINDS: readonly ActionResultKind[] = [
  ActionResultKind.Submitted,
  ActionResultKind.AwaitingPrerequisite,
];

export async function requestAndRelease(
  run: ExecutionRun,
): Promise<ExecutionEnd> {
  const items = await run.requestActions();
  if (!items.every((item) => ACCEPTED_ITEM_KINDS.includes(item.kind)))
    return run.stop(EndReason.ActionUnsettled);
  return run.release(false);
}

const NO_ITEMS = 0;
const VERIFICATION_RERUNS = 2;
export const VERIFICATION_SUBJECT = "Evaluation verification results";
type OpenAgent = (directory: string) => Promise<NativeAgent>;

async function judge(
  input: StepsInput,
  run: ExecutionRun,
  revision: Revision,
  evidence: unknown,
  verificationRun: VerificationRun,
  directory: string,
  checkouts: readonly ExamineCheckout[],
  openAgent: OpenAgent,
  dependencies: Awaited<ReturnType<typeof readDependencies>> | null,
) {
  const examine = input.setup.work === ExecutionWork.Examine;
  const commands = verificationCommands(revision);
  const verification = verificationRun.verification;
  if (!verificationPassed(verification, commands))
    return {
      result: AssessmentResult.CriterionNotMet,
      rationale: failedVerificationReport(verificationRun, commands),
      proposals: [],
    };
  const agent = await openAgent(directory);
  if (agent.budget.exhausted()) return run.stop(EndReason.AssessmentAbsent);
  const work = renderWorkPrompt(input.setup.templates, {
    node_id: input.claim.node_id,
    revision: input.claim.pinned_revision,
    content: revision.content,
    repositories: workRepositoriesOf(directory, checkouts),
  });
  await agent.instruct(
    work,
    evaluationInstruction(input.setup.templates, {
      examine,
      tasks: revision.tasks,
      verification,
      evidence,
      dependencies,
    }),
  );
  if (agent.budget.exhausted()) return run.stop(EndReason.AssessmentAbsent);
  const judgement = await parseRepaired(
    input.setup.templates,
    agent,
    work,
    evaluationJudgementSchema,
  );
  if (judgement === ReplyRepair.BudgetEnd)
    return run.stop(EndReason.AssessmentAbsent);
  if (judgement === ReplyRepair.Invalid)
    return run.stop(EndReason.JudgementInvalid);
  run.log("node judged", {
    result: judgement.result,
    unmet: judgement.unmet.map((item) => item.id),
  });
  const proposals = examine ? judgement.proposals : [];
  return {
    result:
      proposals.length > NO_ITEMS
        ? AssessmentResult.Undetermined
        : judgement.result,
    rationale: judgementRationale(judgement),
    proposals,
  };
}

type PreparedEvaluation = Awaited<ReturnType<typeof prepareEvaluation>>;

async function evaluate(
  input: StepsInput,
  run: ExecutionRun,
  revision: Revision,
  prepared: PreparedEvaluation,
  budget: ExecutionBudget,
  openAgent: OpenAgent,
) {
  assert.ok(prepared.directory);
  assert.equal(input.claim.execution_id, input.setup.execution_id);
  const verificationRun = await runVerificationsWithOutput({
    observe: verificationObserver(
      run.spans,
      testedCommitOf(prepared.tested_input),
    ),
    directory: prepared.directory,
    commands: verificationCommands(revision),
    tested_input: prepared.tested_input,
    deadline: budget.wallDeadline(),
    context: run.operationContext,
    env: input.env,
    reruns: VERIFICATION_RERUNS,
  });
  const verification = verificationRun.verification;
  const recorded = await run.submitEvidence(input.claim.node_id, {
    subject: VERIFICATION_SUBJECT,
    assets: [
      {
        kind: "produced",
        content: {
          media_type: "application/json",
          encoding: "base64",
          data: Buffer.from(canonicalJSON(verification.results)).toString(
            "base64",
          ),
        },
      },
    ],
    verification,
  });
  const dependencies =
    input.setup.work === ExecutionWork.Examine
      ? await readDependencies(run)
      : null;
  let judgement: Awaited<ReturnType<typeof judge>>;
  try {
    judgement = await judge(
      input,
      run,
      revision,
      prepared.reviewBundle,
      verificationRun,
      prepared.directory,
      prepared.checkouts,
      openAgent,
      dependencies,
    );
  } catch (error) {
    if (
      (error instanceof ContextCancelled ||
        error instanceof DeadlineExceeded) &&
      budget.exhausted() &&
      !run.operationContext.err()
    )
      return run.stop(EndReason.AssessmentAbsent);
    throw error;
  }
  return {
    evidence_ids: [recorded.id, ...prepared.evidenceIds],
    dependency_outcome_ids:
      dependencies?.outcomes.map((outcome) => outcome.id) ?? [],
    ...judgement,
  };
}

export async function runEvaluation(
  input: StepsInput,
  run: ExecutionRun,
  budget: ExecutionBudget,
  openAgent: OpenAgent,
): Promise<ExecutionEnd> {
  const revision = await readPinnedRevision(run);
  const evidence = await readAttemptEvidence(run);
  const prepared = await prepareEvaluation(
    input,
    run,
    input.setup.work,
    evidence,
  );
  try {
    const assessment = await run.spans.within(
      evaluationSpan(run.spans, testedCommitOf(prepared.tested_input)),
      () => evaluate(input, run, revision, prepared, budget, openAgent),
      evaluationEnd,
    );
    const answer = await run.submitAssessment(input.claim.node_id, {
      ...assessment,
      tested_input: prepared.tested_input,
    });
    if (answer.outcome)
      return { kind: ExecutionEndKind.Closed, outcomeId: answer.outcome.id };
    if (answer.assessment.result === AssessmentResult.Success)
      return await requestAndRelease(run);
    if (
      answer.assessment.result === AssessmentResult.CriterionNotMet &&
      !("state" in answer.node && answer.node.state === NodeState.Evaluating)
    )
      return {
        kind: ExecutionEndKind.Ended,
        reason: EndReason.Revoked,
        code: null,
      };
    return run.stop(EndReason.OperationFailed);
  } finally {
    input.workspaces.release(prepared.key, WorkspaceKind.Execution);
  }
}
