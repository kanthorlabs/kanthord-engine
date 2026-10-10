import { canonicalJSON } from "../kernel/json.ts";
import {
  AssessmentResult,
  NodeState,
  type Revision,
} from "../mission/contract.ts";
import { ExecutionBudget } from "./budget.ts";
import {
  EndReason,
  ExecutionEndKind,
  type ExecutionEnd,
  type ExecutionRun,
} from "./execution-run.ts";
import {
  nodeKindOf,
  readAttemptEvidence,
  readObjectives,
  readPinnedRevision,
} from "./node-reads.ts";
import { NodeKind, type NativeAgent } from "./native-agent.ts";
import { prepareEvaluation, verificationCommands } from "./evaluation-input.ts";
import {
  runVerifications,
  verificationPassed,
  type Verification,
} from "./verification.ts";
import {
  evaluationInstruction,
  evaluationJudgementSchema,
  judgementRationale,
  failedVerificationRationale,
  parseRepaired,
  ReplyRepair,
} from "./judgement.ts";
import { renderWorkPrompt } from "../agent/prompt-composer.ts";
import type { StepsInput } from "./steps-objective.ts";
import { WorkspaceKind } from "./workspace.ts";
import { ActionResultKind } from "./contract.ts";

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

export const VERIFICATION_SUBJECT = "Evaluation verification results";
type OpenAgent = (directory: string) => Promise<NativeAgent>;

async function judge(
  input: StepsInput,
  run: ExecutionRun,
  revision: Revision,
  evidence: unknown,
  verification: Verification,
  directory: string,
  openAgent: OpenAgent,
  objectives: Awaited<ReturnType<typeof readObjectives>> | null,
) {
  const commands = verificationCommands(revision);
  if (!verificationPassed(verification, commands))
    return {
      result: AssessmentResult.CriterionNotMet,
      rationale: failedVerificationRationale(verification, commands),
    };
  const agent = await openAgent(directory);
  if (agent.budget.exhausted()) return run.stop(EndReason.AssessmentAbsent);
  const work = renderWorkPrompt({
    node_id: input.claim.node_id,
    revision: input.claim.pinned_revision,
    content: revision.content,
  });
  await agent.instruct(
    work,
    evaluationInstruction({
      tasks: revision.tasks ?? [],
      verification,
      evidence,
      objectives,
    }),
  );
  if (agent.budget.exhausted()) return run.stop(EndReason.AssessmentAbsent);
  const judgement = await parseRepaired(agent, work, evaluationJudgementSchema);
  if (judgement === ReplyRepair.BudgetEnd)
    return run.stop(EndReason.AssessmentAbsent);
  if (judgement === ReplyRepair.Invalid)
    return run.stop(EndReason.JudgementInvalid);
  run.log("node judged", {
    result: judgement.result,
    unmet: judgement.unmet.map((item) => item.id),
  });
  return { result: judgement.result, rationale: judgementRationale(judgement) };
}

export async function runEvaluation(
  input: StepsInput,
  run: ExecutionRun,
  openAgent: OpenAgent,
): Promise<ExecutionEnd> {
  const revision = await readPinnedRevision(run);
  const evidence = await readAttemptEvidence(run);
  const kind = nodeKindOf(revision);
  const prepared = await prepareEvaluation(input, run, kind, evidence);
  try {
    const budget = new ExecutionBudget({
      ...input.claim,
      resource_budget: input.setup.resource_budget,
    });
    const verification = await runVerifications({
      directory: prepared.directory,
      commands: verificationCommands(revision),
      tested_input: prepared.tested_input,
      deadline: budget.wallDeadline(),
      context: run.operationContext,
    });
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
    const objectives =
      kind === NodeKind.Initiative ? await readObjectives(run) : null;
    const childOutcomeIds =
      objectives?.outcomes.map((outcome) => outcome.id) ?? [];
    const judgement = await judge(
      input,
      run,
      revision,
      prepared.reviewBundle,
      verification,
      prepared.directory,
      openAgent,
      objectives,
    );
    const answer = await run.submitAssessment(input.claim.node_id, {
      evidence_ids: [recorded.id, ...prepared.evidenceIds],
      child_outcome_ids: childOutcomeIds,
      ...judgement,
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
    input.workspaces.release(prepared.directory, WorkspaceKind.Execution);
  }
}
