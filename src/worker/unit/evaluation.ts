import assert from "node:assert/strict";
import { PromptTemplate } from "../../agent/contract.ts";
import type { SetupFailure } from "./environment-setup.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import {
  AssessmentResult,
  AssetKind,
  NodeState,
  type Revision,
} from "../../mission/contract.ts";
import {
  AFFECTED_SUBJECT,
  affectedEvidenceOf,
  AffectedVerdict,
  runAffected,
  type AffectedEvidence,
  type AffectedResult,
} from "./affected.ts";
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
  environmentStop,
  infrastructureStop,
  runVerificationsWithOutput,
  VerificationClass,
  verificationPassed,
  type VerificationRun,
} from "./verification.ts";
import {
  affectedFailureReport,
  evaluationInstruction,
  evaluationJudgementSchema,
  judgementRationale,
  failedVerificationReport,
  parseRepaired,
  ReplyRepair,
  type UnmetGround,
} from "./judgement.ts";
import {
  EvaluationStage,
  reworkCauseOf,
  type EvaluationFacts,
} from "./rework-cause.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import type { StepsInput } from "./steps-implement.ts";
import { commandOwners } from "./release-gate.ts";
import {
  WorkspaceKind,
  workRepositoriesOf,
  type ExamineCheckout,
} from "./workspace.ts";
import { ActionResultKind, ExecutionIntent } from "../contract.ts";
import {
  evaluationEnd,
  evaluationSpan,
  testedCommitOf,
  environmentDigestsOf,
  verificationObserver,
  VerificationContext,
} from "./method-telemetry.ts";
import type { TestedInput } from "./verification.ts";

export { EvaluationStage };

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

function factsOf(
  stage: EvaluationStage,
  verificationRun: VerificationRun,
  unmet: readonly { id: string; ground: UnmetGround }[] = [],
  proposalCount = NO_ITEMS,
  repaired: boolean | null = null,
  affected: AffectedVerdict | null = null,
): EvaluationFacts {
  return {
    stage,
    unmet_ids: unmet.map((item) => item.id),
    unmet_grounds: unmet.map((item) => item.ground),
    proposal_count: proposalCount,
    repaired,
    verification_class: verificationRun.outcome,
    affected,
  };
}

interface GateFilesEntry {
  binding_id: string;
  paths: string[];
}

interface AffectedStep {
  results: AffectedResult[];
  gate_files: GateFilesEntry[];
  verdict: AffectedVerdict;
  document: AffectedEvidence | null;
}

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
  setupFailure: SetupFailure | null,
  affected: AffectedStep | null,
) {
  const examine = input.setup.intent === ExecutionIntent.Examine;
  const commands = verificationCommands(revision);
  const verification = verificationRun.verification;
  if (verificationRun.outcome === VerificationClass.BudgetEnd)
    return run.stop(EndReason.AssessmentAbsent);
  const stop =
    infrastructureStop(verificationRun) ?? environmentStop(verificationRun);
  if (stop) throw stop;
  const setupAssessment = setupFailureAssessment(setupFailure);
  if (setupAssessment)
    return {
      ...setupAssessment,
      facts: factsOf(EvaluationStage.Setup, verificationRun),
    };
  if (!verificationPassed(verification, commands))
    return {
      result: AssessmentResult.CriterionNotMet,
      rationale: failedVerificationReport(verificationRun, commands),
      proposals: [],
      facts: factsOf(EvaluationStage.Verification, verificationRun),
    };
  if (affected?.verdict === AffectedVerdict.Failed)
    return {
      result: AssessmentResult.CriterionNotMet,
      rationale: affectedFailureReport(affected.results),
      proposals: [],
      facts: factsOf(
        EvaluationStage.Affected,
        verificationRun,
        [],
        NO_ITEMS,
        null,
        affected.verdict,
      ),
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
      affected: affected?.document ?? null,
    }),
    PromptTemplate.Evaluation,
  );
  if (agent.budget.exhausted()) return run.stop(EndReason.AssessmentAbsent);
  const { reply: judgement, repaired } = await parseRepaired(
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
    facts: factsOf(
      EvaluationStage.Judgement,
      verificationRun,
      judgement.unmet,
      proposals.length,
      repaired,
      affected?.verdict ?? null,
    ),
  };
}

export function setupFailureAssessment(setupFailure: SetupFailure | null) {
  if (setupFailure === null) return null;
  return {
    result: AssessmentResult.CriterionNotMet,
    rationale: failedVerificationReport(
      setupFailure.run,
      setupFailure.commands,
    ),
    proposals: [],
  };
}

type PreparedEvaluation = Awaited<ReturnType<typeof prepareEvaluation>>;

function baselineOf(base: PreparedEvaluation["base"]) {
  return base === null
    ? {}
    : { baseline: (command: string) => base.exitOf(command) };
}

function headOf(testedInput: TestedInput, bindingId: string): string {
  const addresses = Array.isArray(testedInput) ? testedInput : [testedInput];
  const address = addresses.find(
    (entry) =>
      entry.kind === AssetKind.Repository && entry.binding_id === bindingId,
  );
  assert.ok(address?.kind === AssetKind.Repository);
  return address.commit;
}

async function runAffectedStep(
  input: StepsInput,
  run: ExecutionRun,
  prepared: PreparedEvaluation,
  budget: ExecutionBudget,
): Promise<AffectedStep> {
  assert.ok(prepared.base);
  const results: AffectedResult[] = [];
  for (const checkout of prepared.checkouts) {
    const repository = input.setup.repositories.find(
      (entry) => entry.name === checkout.name,
    );
    assert.ok(repository);
    const result = await runAffected({
      env: input.env,
      context: run.operationContext,
      deadline: budget.wallDeadline(),
      exhausted: () => budget.exhausted(),
      spans: run.spans,
      scope: VerificationContext.Evaluation,
      workspaceKey: prepared.key,
      checkout: {
        binding_id: repository.binding_id,
        name: checkout.name,
        directory: checkout.directory,
        base_branch: checkout.base_branch,
        head: headOf(prepared.tested_input, repository.binding_id),
      },
      digests: environmentDigestsOf(input.setup.repositories),
      base: prepared.base,
    });
    if ("budgetEnd" in result) return run.stop(EndReason.AssessmentAbsent);
    results.push(result);
  }
  const evidence = affectedEvidenceOf(results);
  return {
    results,
    gate_files: results.flatMap((result) =>
      result.verdict !== AffectedVerdict.Absent &&
      result.gate_files.length > NO_ITEMS
        ? [{ binding_id: result.binding_id, paths: result.gate_files }]
        : [],
    ),
    verdict: evidence.verdict,
    document: evidence.repositories.length > NO_ITEMS ? evidence : null,
  };
}

async function endedByBudget<T>(
  run: ExecutionRun,
  budget: ExecutionBudget,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      (error instanceof ContextCancelled ||
        error instanceof DeadlineExceeded) &&
      budget.exhausted() &&
      !run.operationContext.signal.aborted
    )
      return run.stop(EndReason.AssessmentAbsent);
    throw error;
  }
}

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
  const owners = commandOwners({ input, revision });
  const verificationRun = await runVerificationsWithOutput({
    observe: verificationObserver(
      run.spans,
      testedCommitOf(prepared.tested_input),
      environmentDigestsOf(input.setup.repositories),
      {
        context: VerificationContext.Evaluation,
        ownerOf: (index) => owners[index]!.id,
      },
    ),
    directory: prepared.directory,
    commands: verificationCommands(revision),
    tested_input: prepared.tested_input,
    deadline: budget.wallDeadline(),
    context: run.operationContext,
    env: input.env,
    reruns: VERIFICATION_RERUNS,
    exhausted: () => budget.exhausted(),
    ...baselineOf(prepared.base),
  });
  run.noteVerification(
    verificationRun.verification.results.at(-1)?.timed_out ?? false,
  );
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
  const affected =
    input.setup.intent === ExecutionIntent.Implement &&
    prepared.checkouts.length > NO_ITEMS &&
    prepared.setupFailure === null &&
    verificationPassed(verification, verificationCommands(revision))
      ? await endedByBudget(run, budget, () =>
          runAffectedStep(input, run, prepared, budget),
        )
      : null;
  const recordedAffected =
    affected?.document == null
      ? null
      : await run.submitEvidence(input.claim.node_id, {
          subject: AFFECTED_SUBJECT,
          assets: [
            {
              kind: "produced",
              content: {
                media_type: "application/json",
                encoding: "base64",
                data: Buffer.from(canonicalJSON(affected.document)).toString(
                  "base64",
                ),
              },
            },
          ],
        });
  const dependencies =
    input.setup.intent === ExecutionIntent.Examine
      ? await readDependencies(run)
      : null;
  const judgement = await endedByBudget(run, budget, () =>
    judge(
      input,
      run,
      revision,
      prepared.reviewBundle,
      verificationRun,
      prepared.directory,
      prepared.checkouts,
      openAgent,
      dependencies,
      prepared.setupFailure,
      affected,
    ),
  );
  return {
    evidence_ids: [
      recorded.id,
      ...(recordedAffected ? [recordedAffected.id] : []),
      ...prepared.evidenceIds,
    ],
    dependency_outcome_ids:
      dependencies?.outcomes.map((outcome) => outcome.id) ?? [],
    result: judgement.result,
    rationale: judgement.rationale,
    proposals: judgement.proposals,
    gate_files: affected?.gate_files ?? [],
    facts: judgement.facts,
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
    input.setup.intent,
    evidence,
  );
  try {
    const assessment = await run.spans.within(
      evaluationSpan(run.spans, testedCommitOf(prepared.tested_input)),
      () => evaluate(input, run, revision, prepared, budget, openAgent),
      evaluationEnd,
    );
    const answer = await run.submitAssessment(input.claim.node_id, {
      evidence_ids: assessment.evidence_ids,
      dependency_outcome_ids: assessment.dependency_outcome_ids,
      result: assessment.result,
      rationale: assessment.rationale,
      proposals: assessment.proposals,
      tested_input: prepared.tested_input,
      ...(assessment.gate_files.length > NO_ITEMS
        ? { gate_files: assessment.gate_files }
        : {}),
      ...(assessment.result === AssessmentResult.CriterionNotMet
        ? { cause: reworkCauseOf(assessment.facts) }
        : {}),
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
