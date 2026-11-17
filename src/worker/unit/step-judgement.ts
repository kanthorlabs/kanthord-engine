import { PromptTemplate } from "../../agent/contract.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import {
  AssessmentResult,
  FindingAction,
  FindingKind,
  type ReviewRound,
} from "../../mission/contract.ts";
import { ExecutionIntent } from "../contract.ts";
import { AffectedVerdict } from "./affected.ts";
import {
  DeadlineKind,
  type ExecutionCtx,
  type FoundryIo,
  type FoundryStep,
} from "./chain.ts";
import { setupFailureAssessment } from "./evaluation.ts";
import { verificationCommands } from "./evaluation-input.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import type {
  AgentSession,
  EvaluationPorts,
  LogPort,
} from "./foundry-ports.ts";
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
import { type EvaluationFacts, EvaluationStage } from "./rework-cause.ts";
import { openedAgent } from "./step-agent-open.ts";
import {
  budgetEnd,
  budgetMapped,
  next,
  stopsReturned,
} from "./step-support.ts";
import {
  environmentStop,
  infrastructureStop,
  VerificationClass,
  verificationPassed,
  type VerificationRun,
} from "./verification.ts";
import { workRepositoriesOf } from "./workspace.ts";

const NO_ITEMS = 0;
const NO_PATCHES = 0;

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

interface JudgedOutcome {
  judged?: JudgedFacts;
  affected?: AffectedVerdict | null;
}

function factsOf(
  stage: EvaluationStage,
  context: Pick<JudgeContext, "verificationRun" | "round">,
  { judged = UNJUDGED, affected = null }: JudgedOutcome = {},
): EvaluationFacts {
  const { verificationRun, round } = context;
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

type JudgeKeys =
  | "claim"
  | "setup"
  | "revision"
  | "reviewWorkspace"
  | "placed"
  | "verification"
  | "dependencies"
  | "setupFailure"
  | "affected"
  | "reviewRound";

interface JudgeContext {
  log: LogPort;
  ctx: Readonly<Pick<ExecutionCtx, JudgeKeys>>;
  round: ReviewRound;
  verificationRun: VerificationRun;
}

function judgeContextOf(
  ctx: Readonly<Pick<ExecutionCtx, JudgeKeys>>,
  io: FoundryIo,
): JudgeContext {
  return {
    log: io.ports.log,
    ctx,
    round: ctx.reviewRound,
    verificationRun: ctx.verification,
  };
}

function shortcutAssessment(context: JudgeContext) {
  const { verificationRun } = context;
  const { revision, setupFailure, affected } = context.ctx;
  const commands = verificationCommands(revision);
  const verification = verificationRun.verification;
  const stop =
    infrastructureStop(verificationRun) ?? environmentStop(verificationRun);
  if (stop) throw stop;
  const setupAssessment = setupFailureAssessment(setupFailure);
  if (setupAssessment)
    return {
      ...setupAssessment,
      ...unjudged(),
      facts: factsOf(EvaluationStage.Setup, context),
    };
  if (!verificationPassed(verification, commands))
    return {
      result: AssessmentResult.CriterionNotMet,
      rationale: failedVerificationReport(verificationRun, commands),
      proposals: [],
      ...unjudged(),
      facts: factsOf(EvaluationStage.Verification, context),
    };
  if (affected?.verdict === AffectedVerdict.Failed)
    return {
      result: AssessmentResult.CriterionNotMet,
      rationale: affectedFailureReport(affected.results),
      proposals: [],
      ...unjudged(),
      facts: factsOf(EvaluationStage.Affected, context, {
        affected: affected.verdict,
      }),
    };
  return null;
}

async function askJudgement(context: JudgeContext, agent: AgentSession) {
  const { round } = context;
  const { claim, setup, revision } = context.ctx;
  const evidence = context.ctx.placed.reviewBundle;
  const { directory, checkouts } = context.ctx.reviewWorkspace;
  const work = renderWorkPrompt(setup.templates, {
    node_id: claim.node_id,
    revision: claim.pinned_revision,
    content: revision.content,
    repositories: workRepositoriesOf(directory, checkouts),
  });
  const examine = setup.intent === ExecutionIntent.Examine;
  await agent.instruct(
    work,
    evaluationInstruction(setup.templates, {
      examine,
      fullChange:
        !examine &&
        round.review_base === null &&
        evidence.patch_paths.length > NO_PATCHES,
      tasks: revision.tasks,
      verification: context.verificationRun.verification,
      evidence,
      dependencies: context.ctx.dependencies,
      affected: context.ctx.affected?.document ?? null,
      round: { number: round.round, review_base: round.review_base },
      priorFindings: round.findings,
    }),
    PromptTemplate.Evaluation,
  );
  if (agent.budget.exhausted()) return null;
  const { reply: judgement, repaired } = await parseRepaired(
    setup.templates,
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
  if (judgement === ReplyRepair.BudgetEnd) return null;
  if (judgement === ReplyRepair.Invalid)
    throw new ExecutionStop(EndReason.JudgementInvalid, null);
  return { judgement, repaired };
}

function judgedAssessment(
  context: JudgeContext,
  asked: NonNullable<Awaited<ReturnType<typeof askJudgement>>>,
) {
  const { log, verificationRun, round } = context;
  const { claim, setup, affected } = context.ctx;
  const { judgement, repaired } = asked;
  const blockers = judgementBlockers(claim.node_id, judgement, round.findings);
  log.log("node judged", {
    result: judgement.result,
    unmet: blockers.map((item) => item.id),
    findings: judgement.findings.map((finding) => finding.label),
    fixed: judgement.fixed_finding_ids,
  });
  const proposals =
    setup.intent === ExecutionIntent.Examine ? judgement.proposals : [];
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
    facts: factsOf(EvaluationStage.Judgement, context, {
      judged: {
        blockers,
        findings: judgement.findings,
        fixedCount: judgement.fixed_finding_ids.length,
        proposalCount: proposals.length,
        repaired,
      },
      affected: affected?.verdict ?? null,
    }),
  };
}

export type EvaluationAssessment =
  | NonNullable<ReturnType<typeof shortcutAssessment>>
  | ReturnType<typeof judgedAssessment>;

type JudgementStep = FoundryStep<
  unknown,
  JudgeKeys,
  "judgement",
  EvaluationPorts
>;

export const judgement: JudgementStep = {
  foundry: true,
  id: "judgement",
  deadline: DeadlineKind.Work,
  reads: [
    "claim",
    "setup",
    "revision",
    "reviewWorkspace",
    "placed",
    "verification",
    "dependencies",
    "setupFailure",
    "affected",
    "reviewRound",
  ],
  writes: ["judgement"],
  stops: [
    "operation_failed/worker.verification.infrastructure_failed",
    "environment_failed/verification_timeout",
    "environment_failed/command_absent",
    "judgement_invalid",
    "operation_failed",
    "provider_failed",
  ],
  llm: true,
  note: "port: agent.open; shortcut on failure -> criterion-not-met; else Evaluation, Repair once; budget end",
  run(ctx, scope, io) {
    return stopsReturned(scope, () =>
      budgetMapped(io, scope, async () => {
        const context = judgeContextOf(ctx, io);
        if (ctx.verification.outcome === VerificationClass.BudgetEnd)
          return budgetEnd(scope);
        const shortcut = shortcutAssessment(context);
        if (shortcut !== null) return next(scope, { judgement: shortcut });
        const agent = await openedAgent(ctx, io);
        if (agent === null || agent.budget.exhausted()) return budgetEnd(scope);
        const asked = await askJudgement(context, agent);
        if (asked === null) return budgetEnd(scope);
        return next(scope, { judgement: judgedAssessment(context, asked) });
      }),
    );
  },
};
