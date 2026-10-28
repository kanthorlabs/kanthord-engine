import { z } from "zod";

const NO_SUSPECTS = 0;

export const CauseCategory = {
  Prompt: "prompt",
  Plan: "plan",
  WorkerAction: "worker_action",
  LlmProvider: "llm_provider",
  Model: "model",
  Environment: "environment",
  Infrastructure: "infrastructure",
  Human: "human",
  Unattributed: "unattributed",
} as const;
export const causeCategorySchema = z.enum(CauseCategory);
export type CauseCategory = z.infer<typeof causeCategorySchema>;

export const CauseSubcategory = {
  ContextMissing: "context_missing",
  InstructionConflict: "instruction_conflict",
  RuleAbsent: "rule_absent",
  CriterionUnstated: "criterion_unstated",
  RequirementConflict: "requirement_conflict",
  Dependency: "dependency",
  VerificationContext: "verification_context",
  VerificationInsufficient: "verification_insufficient",
  Decomposition: "decomposition",
  Oversized: "oversized",
  GateCommit: "gate_commit",
  MergeBase: "merge_base",
  ReleaseGate: "release_gate",
  ReviewFlow: "review_flow",
  StepFailed: "step_failed",
  RateLimited: "rate_limited",
  QuotaExhausted: "quota_exhausted",
  Unavailable: "unavailable",
  WorkDefect: "work_defect",
  StandardViolation: "standard_violation",
  VerificationFailed: "verification_failed",
  NoProgress: "no_progress",
  ReplyInvalid: "reply_invalid",
  ProtocolViolation: "protocol_violation",
  OutputTruncated: "output_truncated",
  BudgetExhausted: "budget_exhausted",
  JudgementWrong: "judgement_wrong",
  SetupFailed: "setup_failed",
  CommandAbsent: "command_absent",
  AffectedInvalid: "affected_invalid",
  AffectedTimeout: "affected_timeout",
  FlakyVerification: "flaky_verification",
  VerificationHang: "verification_hang",
  RepositoryHook: "repository_hook",
  VerificationKilled: "verification_killed",
  Network: "network",
  ExecutionLost: "execution_lost",
  Intervention: "intervention",
  Configuration: "configuration",
} as const;
export const causeSubcategorySchema = z.enum(CauseSubcategory);
export type CauseSubcategory = z.infer<typeof causeSubcategorySchema>;

export const CAUSE_SUBCATEGORIES: Readonly<
  Record<CauseCategory, readonly CauseSubcategory[]>
> = {
  [CauseCategory.Prompt]: [
    CauseSubcategory.ContextMissing,
    CauseSubcategory.InstructionConflict,
    CauseSubcategory.RuleAbsent,
  ],
  [CauseCategory.Plan]: [
    CauseSubcategory.CriterionUnstated,
    CauseSubcategory.RequirementConflict,
    CauseSubcategory.Dependency,
    CauseSubcategory.VerificationContext,
    CauseSubcategory.VerificationInsufficient,
    CauseSubcategory.Decomposition,
    CauseSubcategory.Oversized,
  ],
  [CauseCategory.WorkerAction]: [
    CauseSubcategory.GateCommit,
    CauseSubcategory.MergeBase,
    CauseSubcategory.ReleaseGate,
    CauseSubcategory.ReviewFlow,
    CauseSubcategory.StepFailed,
  ],
  [CauseCategory.LlmProvider]: [
    CauseSubcategory.RateLimited,
    CauseSubcategory.QuotaExhausted,
    CauseSubcategory.Unavailable,
  ],
  [CauseCategory.Model]: [
    CauseSubcategory.WorkDefect,
    CauseSubcategory.StandardViolation,
    CauseSubcategory.VerificationFailed,
    CauseSubcategory.NoProgress,
    CauseSubcategory.ReplyInvalid,
    CauseSubcategory.ProtocolViolation,
    CauseSubcategory.OutputTruncated,
    CauseSubcategory.BudgetExhausted,
    CauseSubcategory.JudgementWrong,
  ],
  [CauseCategory.Environment]: [
    CauseSubcategory.SetupFailed,
    CauseSubcategory.CommandAbsent,
    CauseSubcategory.AffectedInvalid,
    CauseSubcategory.AffectedTimeout,
    CauseSubcategory.FlakyVerification,
    CauseSubcategory.VerificationHang,
    CauseSubcategory.RepositoryHook,
  ],
  [CauseCategory.Infrastructure]: [
    CauseSubcategory.VerificationKilled,
    CauseSubcategory.Network,
    CauseSubcategory.ExecutionLost,
  ],
  [CauseCategory.Human]: [
    CauseSubcategory.Intervention,
    CauseSubcategory.Configuration,
  ],
  [CauseCategory.Unattributed]: [],
};

export const CauseAssigner = {
  Rule: "rule",
  Reviewer: "reviewer",
  Human: "human",
} as const;
export const causeAssignerSchema = z.enum(CauseAssigner);
export type CauseAssigner = z.infer<typeof causeAssignerSchema>;

export const effectiveCauseSchema = z
  .strictObject({
    category: causeCategorySchema,
    assigner: causeAssignerSchema,
    subcategory: causeSubcategorySchema.optional(),
    suspects: z.array(causeCategorySchema).optional(),
  })
  .superRefine((cause, context) => {
    if (cause.category === CauseCategory.Unattributed) {
      if (cause.subcategory !== undefined)
        context.addIssue({
          code: "custom",
          path: ["subcategory"],
          message: "An unattributed cause has no subcategory.",
        });
      if (cause.suspects === undefined)
        return context.addIssue({
          code: "custom",
          path: ["suspects"],
          message: "An unattributed cause has suspects.",
        });
      const unique = new Set(cause.suspects).size === cause.suspects.length;
      if (!unique || cause.suspects.includes(CauseCategory.Unattributed))
        context.addIssue({
          code: "custom",
          path: ["suspects"],
          message: "The suspects are unique and never unattributed.",
        });
      return;
    }
    if (cause.suspects !== undefined)
      context.addIssue({
        code: "custom",
        path: ["suspects"],
        message: "An attributed cause has no suspects.",
      });
    const allowed = CAUSE_SUBCATEGORIES[cause.category];
    if (cause.subcategory === undefined || !allowed.includes(cause.subcategory))
      context.addIssue({
        code: "custom",
        path: ["subcategory"],
        message: `The subcategory must belong to ${cause.category}.`,
      });
  });
export type EffectiveCause = z.infer<typeof effectiveCauseSchema>;

export const failureCauseSchema = effectiveCauseSchema.refine(
  (cause) =>
    cause.assigner === CauseAssigner.Rule ||
    cause.assigner === CauseAssigner.Reviewer,
  { path: ["assigner"] },
);
export type FailureCause = z.infer<typeof failureCauseSchema>;

export const CauseAttribute = {
  Category: "kanthord.cause.category",
  Subcategory: "kanthord.cause.subcategory",
  Suspects: "kanthord.cause.suspects",
  Assigner: "kanthord.cause.assigner",
} as const;

export function causeAttributes(
  cause: EffectiveCause,
): Readonly<Record<string, string | readonly string[]>> {
  return {
    [CauseAttribute.Category]: cause.category,
    [CauseAttribute.Assigner]: cause.assigner,
    ...(cause.subcategory === undefined
      ? {}
      : { [CauseAttribute.Subcategory]: cause.subcategory }),
    ...(cause.suspects === undefined || cause.suspects.length === NO_SUSPECTS
      ? {}
      : { [CauseAttribute.Suspects]: cause.suspects }),
  };
}

export function unattributed(suspects: readonly CauseCategory[]): FailureCause {
  return failureCauseSchema.parse({
    category: CauseCategory.Unattributed,
    assigner: CauseAssigner.Rule,
    suspects,
  });
}

export function attributed(
  category: CauseCategory,
  subcategory: CauseSubcategory,
  assigner: CauseAssigner = CauseAssigner.Rule,
): FailureCause {
  return failureCauseSchema.parse({ category, assigner, subcategory });
}
