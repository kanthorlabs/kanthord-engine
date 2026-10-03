import { canonicalJSON } from "../kernel/json.ts";
import {
  AssessmentResult,
  type Evidence,
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
  failedVerificationRationale,
  parseJudgement,
} from "./judgement.ts";
import { renderWorkPrompt } from "./prompt-composer.ts";
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
  evidence: Evidence[],
  verification: Verification,
  directory: string,
  openAgent: OpenAgent,
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
    nodeId: input.claim.nodeId,
    revision: input.claim.pinnedRevision,
    content: revision.content,
  });
  await agent.instruct(
    work,
    evaluationInstruction({
      tasks: revision.tasks ?? [],
      testedInput: verification.testedInput,
      evidence,
    }),
  );
  if (agent.budget.exhausted()) return run.stop(EndReason.AssessmentAbsent);
  const judgement = parseJudgement(agent.lastText(), evaluationJudgementSchema);
  if (!judgement) return run.stop(EndReason.JudgementInvalid);
  return judgement;
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
      resourceBudget: input.setup.resourceBudget,
    });
    const verification = await runVerifications({
      directory: prepared.directory,
      commands: verificationCommands(revision),
      testedInput: prepared.testedInput,
      deadline: budget.wallDeadline(),
      context: run.operationContext,
    });
    const recorded = await run.submitEvidence(input.claim.nodeId, {
      subject: VERIFICATION_SUBJECT,
      assets: [
        {
          kind: "produced",
          content: {
            mediaType: "application/json",
            encoding: "base64",
            data: Buffer.from(canonicalJSON(verification.results)).toString(
              "base64",
            ),
          },
        },
      ],
      verification,
    });
    const childOutcomeIds =
      kind === NodeKind.Initiative
        ? (await readObjectives(run)).outcomes.map((outcome) => outcome.id)
        : [];
    const judgement = await judge(
      input,
      run,
      revision,
      evidence,
      verification,
      prepared.directory,
      openAgent,
    );
    const answer = await run.submitAssessment(input.claim.nodeId, {
      evidenceIds: [recorded.id, ...prepared.evidenceIds],
      childOutcomeIds,
      ...judgement,
      testedInput: prepared.testedInput,
    });
    if (answer.outcome)
      return { kind: ExecutionEndKind.Closed, outcomeId: answer.outcome.id };
    if (answer.assessment.result === AssessmentResult.Success)
      return await requestAndRelease(run);
    return run.stop(EndReason.OperationFailed);
  } finally {
    input.workspaces.release(prepared.directory, WorkspaceKind.Execution);
  }
}
