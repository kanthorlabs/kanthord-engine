import assert from "node:assert/strict";
import { PromptTemplate } from "../../agent/contract.ts";
import type { SetupFailure } from "./environment-setup.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import {
  AssessmentResult,
  AssetKind,
  FindingAction,
  FindingKind,
  NodeState,
  type ReviewRound,
  type Revision,
} from "../../mission/contract.ts";
import {
  AFFECTED_SUBJECT,
  type AffectedEvidence,
  affectedEvidenceOf,
  type AffectedResult,
  AffectedVerdict,
  runAffected,
} from "./affected.ts";
import type { ExecutionBudget } from "./budget.ts";
import { ContextCancelled, DeadlineExceeded } from "../../kernel/context.ts";
import {
  EndReason,
  type ExecutionEnd,
  ExecutionEndKind,
  type ExecutionRun,
} from "./execution-run.ts";
import {
  readAttemptEvidence,
  readDependencies,
  readPinnedRevision,
  readReviewRound,
} from "./node-reads.ts";
import {
  ROUND_PATCH_MEDIA_TYPE,
  ROUND_PATCH_SUBJECT,
  roundPatchContent,
} from "./round-patch.ts";
import type { NativeAgent } from "./native-agent.ts";
import { prepareEvaluation, verificationCommands } from "./evaluation-input.ts";
import {
  environmentStop,
  infrastructureStop,
  runVerificationsWithOutput,
  VERIFICATION_RERUNS,
  VerificationClass,
  verificationPassed,
  type VerificationRun,
} from "./verification.ts";
import {
  affectedFailureReport,
  type Blocker,
  evaluationInstruction,
  evaluationJudgementSchemaOf,
  failedVerificationReport,
  judgementBlockers,
  type JudgementFinding,
  judgementRationale,
  parseRepaired,
  ReplyRepair,
  withFlakyVerification,
} from "./judgement.ts";
import {
  type EvaluationFacts,
  EvaluationStage,
  reworkCauseOf,
} from "./rework-cause.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import type { StepsInput } from "./steps-implement.ts";
import { commandOwners } from "./release-gate.ts";
import { type ExamineCheckout, workRepositoriesOf } from "./workspace.ts";
import { ActionResultKind, ExecutionIntent } from "../contract.ts";
import {
  environmentDigestsOf,
  evaluationEnd,
  evaluationSpan,
  testedCommitOf,
  VerificationContext,
  verificationObserver,
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
const NO_PATCHES = 0;
export const VERIFICATION_SUBJECT = "Evaluation verification results";
type OpenAgent = (directory: string) => Promise<NativeAgent>;

interface JudgedFacts {
  blockers: readonly Blocker[];
  findings: readonly JudgementFinding[];
  fixedCount: number;
  proposalCount: number;
  repaired: boolean | null;
}

const UNJUDGED: JudgedFacts = {
  blockers: [],
  findings: [],
  fixedCount: NO_ITEMS,
  proposalCount: NO_ITEMS,
  repaired: null,
};

function factsOf(
  stage: EvaluationStage,
  verificationRun: VerificationRun,
  round: ReviewRound,
  judged: JudgedFacts = UNJUDGED,
  affected: AffectedVerdict | null = null,
): EvaluationFacts {
  return {
    stage,
    unmet_ids: judged.blockers.map((item) => item.id),
    unmet_grounds: judged.blockers.map((item) => item.ground),
    proposal_count: judged.proposalCount,
    repaired: judged.repaired,
    verification_class: verificationRun.outcome,
    affected,
    round: round.round,
    final_round: round.final,
    action_labels: judged.findings
      .filter((finding) => finding.action === FindingAction.Yes)
      .map((finding) => finding.label),
    fixed_count: judged.fixedCount,
  };
}

function unjudged() {
  return { findings: [], fixed_finding_ids: [] };
}

interface AffectedStep {
  results: AffectedResult[];
  verdict: AffectedVerdict;
  document: AffectedEvidence | null;
}

type Dependencies = Awaited<ReturnType<typeof readDependencies>> | null;

interface ReviewEvidence {
  patch_paths: readonly string[];
}

interface JudgeContext {
  input: StepsInput;
  run: ExecutionRun;
  revision: Revision;
  evidence: ReviewEvidence;
  verificationRun: VerificationRun;
  directory: string;
  checkouts: readonly ExamineCheckout[];
  dependencies: Dependencies;
  setupFailure: SetupFailure | null;
  affected: AffectedStep | null;
  round: ReviewRound;
}

function shortcutAssessment(context: JudgeContext) {
  const { run, revision, verificationRun, setupFailure, affected, round } =
    context;
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
      ...unjudged(),
      facts: factsOf(EvaluationStage.Setup, verificationRun, round),
    };
  if (!verificationPassed(verification, commands))
    return {
      result: AssessmentResult.CriterionNotMet,
      rationale: failedVerificationReport(verificationRun, commands),
      proposals: [],
      ...unjudged(),
      facts: factsOf(EvaluationStage.Verification, verificationRun, round),
    };
  if (affected?.verdict === AffectedVerdict.Failed)
    return {
      result: AssessmentResult.CriterionNotMet,
      rationale: affectedFailureReport(affected.results),
      proposals: [],
      ...unjudged(),
      facts: factsOf(
        EvaluationStage.Affected,
        verificationRun,
        round,
        UNJUDGED,
        affected.verdict,
      ),
    };
  return null;
}

async function askJudgement(context: JudgeContext, agent: NativeAgent) {
  const { input, run, revision, evidence, directory, round } = context;
  const work = renderWorkPrompt(input.setup.templates, {
    node_id: input.claim.node_id,
    revision: input.claim.pinned_revision,
    content: revision.content,
    repositories: workRepositoriesOf(directory, context.checkouts),
  });
  const examine = input.setup.intent === ExecutionIntent.Examine;
  await agent.instruct(
    work,
    evaluationInstruction(input.setup.templates, {
      examine,
      fullChange:
        !examine &&
        round.review_base === null &&
        evidence.patch_paths.length > NO_PATCHES,
      tasks: revision.tasks,
      verification: context.verificationRun.verification,
      evidence,
      dependencies: context.dependencies,
      affected: context.affected?.document ?? null,
      round: { number: round.round, review_base: round.review_base },
      priorFindings: round.findings,
    }),
    PromptTemplate.Evaluation,
  );
  if (agent.budget.exhausted()) return run.stop(EndReason.AssessmentAbsent);
  const { reply: judgement, repaired } = await parseRepaired(
    input.setup.templates,
    agent,
    work,
    evaluationJudgementSchemaOf({
      priorIds: round.findings.map((finding) => finding.id),
      priorBlockerIds: round.findings
        .filter((finding) => finding.kind === FindingKind.Blocker)
        .map((finding) => finding.id),
      taskIds: revision.tasks.map((task) => task.id),
    }),
  );
  if (judgement === ReplyRepair.BudgetEnd)
    return run.stop(EndReason.AssessmentAbsent);
  if (judgement === ReplyRepair.Invalid)
    return run.stop(EndReason.JudgementInvalid);
  return { judgement, repaired };
}

function judgedAssessment(
  context: JudgeContext,
  asked: Awaited<ReturnType<typeof askJudgement>>,
) {
  const { input, run, verificationRun, affected, round } = context;
  const { judgement, repaired } = asked;
  const blockers = judgementBlockers(
    input.claim.node_id,
    judgement,
    round.findings,
  );
  run.log("node judged", {
    result: judgement.result,
    unmet: blockers.map((item) => item.id),
    findings: judgement.findings.map((finding) => finding.label),
    fixed: judgement.fixed_finding_ids,
  });
  const proposals =
    input.setup.intent === ExecutionIntent.Examine ? judgement.proposals : [];
  const recorded = withFlakyVerification(
    {
      rationale: judgementRationale({
        rationale: judgement.rationale,
        blockers,
      }),
      findings: judgement.findings,
    },
    verificationRun.flaky_failures,
  );
  return {
    result:
      proposals.length > NO_ITEMS
        ? AssessmentResult.Undetermined
        : judgement.result,
    rationale: recorded.rationale,
    proposals,
    findings: recorded.findings,
    fixed_finding_ids: judgement.fixed_finding_ids,
    facts: factsOf(
      EvaluationStage.Judgement,
      verificationRun,
      round,
      {
        blockers,
        findings: judgement.findings,
        fixedCount: judgement.fixed_finding_ids.length,
        proposalCount: proposals.length,
        repaired,
      },
      affected?.verdict ?? null,
    ),
  };
}

async function judge(
  input: StepsInput,
  run: ExecutionRun,
  revision: Revision,
  evidence: ReviewEvidence,
  verificationRun: VerificationRun,
  directory: string,
  checkouts: readonly ExamineCheckout[],
  openAgent: OpenAgent,
  dependencies: Dependencies,
  setupFailure: SetupFailure | null,
  affected: AffectedStep | null,
  round: ReviewRound,
) {
  const context: JudgeContext = {
    input,
    run,
    revision,
    evidence,
    verificationRun,
    directory,
    checkouts,
    dependencies,
    setupFailure,
    affected,
    round,
  };
  const shortcut = shortcutAssessment(context);
  if (shortcut !== null) return shortcut;
  const agent = await openAgent(directory);
  if (agent.budget.exhausted()) return run.stop(EndReason.AssessmentAbsent);
  return judgedAssessment(context, await askJudgement(context, agent));
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

interface EvaluateContext {
  input: StepsInput;
  run: ExecutionRun;
  revision: Revision;
  prepared: PreparedEvaluation;
  budget: ExecutionBudget;
}

async function verifyEvaluation(context: EvaluateContext) {
  const { input, run, revision, prepared, budget } = context;
  assert.ok(prepared.directory);
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
    copyRepeated: true,
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
  return verificationRun;
}

function submitVerificationEvidence(
  context: EvaluateContext,
  verificationRun: VerificationRun,
) {
  const verification = verificationRun.verification;
  return context.run.submitEvidence(context.input.claim.node_id, {
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
}

async function affectedStepOf(
  context: EvaluateContext,
  verificationRun: VerificationRun,
): Promise<AffectedStep | null> {
  const { input, run, revision, prepared, budget } = context;
  const runnable =
    input.setup.intent === ExecutionIntent.Implement &&
    prepared.checkouts.length > NO_ITEMS &&
    prepared.setupFailure === null &&
    verificationPassed(
      verificationRun.verification,
      verificationCommands(revision),
    );
  if (!runnable) return null;
  return endedByBudget(run, budget, () =>
    runAffectedStep(input, run, prepared, budget),
  );
}

async function submitAffectedEvidence(
  context: EvaluateContext,
  affected: AffectedStep | null,
) {
  if (affected?.document == null) return null;
  return context.run.submitEvidence(context.input.claim.node_id, {
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
}

async function submitPatchEvidence(context: EvaluateContext) {
  const patchIds: string[] = [];
  for (const patch of context.prepared.patches) {
    const submitted = await context.run.submitEvidence(
      context.input.claim.node_id,
      {
        subject: ROUND_PATCH_SUBJECT,
        assets: [
          {
            kind: "produced",
            content: {
              media_type: ROUND_PATCH_MEDIA_TYPE,
              encoding: "base64",
              data: roundPatchContent(patch.text).toString("base64"),
            },
          },
        ],
      },
    );
    patchIds.push(submitted.id);
  }
  return patchIds;
}

async function evaluate(
  input: StepsInput,
  run: ExecutionRun,
  revision: Revision,
  prepared: PreparedEvaluation,
  budget: ExecutionBudget,
  openAgent: OpenAgent,
  round: ReviewRound,
) {
  assert.ok(prepared.directory);
  assert.equal(input.claim.execution_id, input.setup.execution_id);
  const context: EvaluateContext = { input, run, revision, prepared, budget };
  const verificationRun = await verifyEvaluation(context);
  const recorded = await submitVerificationEvidence(context, verificationRun);
  const affected = await affectedStepOf(context, verificationRun);
  const recordedAffected = await submitAffectedEvidence(context, affected);
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
      round,
    ),
  );
  const patchIds = await submitPatchEvidence(context);
  return {
    evidence_ids: [
      recorded.id,
      ...(recordedAffected ? [recordedAffected.id] : []),
      ...patchIds,
      ...prepared.evidenceIds,
    ],
    dependency_outcome_ids:
      dependencies?.outcomes.map((outcome) => outcome.id) ?? [],
    result: judgement.result,
    rationale: judgement.rationale,
    proposals: judgement.proposals,
    findings: judgement.findings,
    fixed_finding_ids: judgement.fixed_finding_ids,
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
  const round = await readReviewRound(run);
  const prepared = await prepareEvaluation(
    input,
    run,
    input.setup.intent,
    evidence,
    round,
  );
  try {
    const assessment = await run.spans.within(
      evaluationSpan(run.spans, testedCommitOf(prepared.tested_input)),
      () => evaluate(input, run, revision, prepared, budget, openAgent, round),
      evaluationEnd,
    );
    const answer = await run.submitAssessment(input.claim.node_id, {
      evidence_ids: assessment.evidence_ids,
      dependency_outcome_ids: assessment.dependency_outcome_ids,
      result: assessment.result,
      rationale: assessment.rationale,
      proposals: assessment.proposals,
      findings: assessment.findings,
      fixed_finding_ids: assessment.fixed_finding_ids,
      tested_input: prepared.tested_input,
      ...(assessment.result === AssessmentResult.CriterionNotMet
        ? { cause: reworkCauseOf(assessment.facts) }
        : {}),
    });
    if (answer.outcome)
      return { kind: ExecutionEndKind.Closed, outcomeId: answer.outcome.id };
    if (!("state" in answer.node && answer.node.state === NodeState.Evaluating))
      return {
        kind: ExecutionEndKind.Ended,
        reason: EndReason.Revoked,
        code: null,
      };
    if (answer.assessment.result === AssessmentResult.Success)
      return await requestAndRelease(run);
    return run.stop(EndReason.OperationFailed);
  } finally {
    input.workspaces.release(prepared.key, prepared.kind);
  }
}
