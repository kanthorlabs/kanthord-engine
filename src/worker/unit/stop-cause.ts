import { z } from "zod";
import {
  attributed,
  CauseCategory,
  CauseSubcategory,
  unattributed,
  type FailureCause,
} from "../../kernel/cause.ts";
import {
  EnvironmentFailure,
  ExecutionStopReason,
  ProviderFailure,
} from "../../scheduler/contract.ts";
import { GitStep } from "./git-step.ts";
import {
  GIT_COMMIT_FAILED,
  MERGE_MARKERS_LEFT,
  TurnViolation,
  VERIFICATION_INFRASTRUCTURE_FAILED,
} from "./stop-codes.ts";

const BINDING_CODE_PREFIX = "project.binding.";
const WORKER_CODE_PREFIX = "worker.";
const GATEWAY_CODE_PREFIX = "gateway.";

export interface StopSignals {
  git_step: GitStep | null;
  verification_timed_out: boolean;
}

const stopDetailSchema = z.looseObject({
  verification: z.looseObject({ timed_out: z.boolean() }),
});

const providerSubcategories: Readonly<Record<string, CauseSubcategory>> = {
  [ProviderFailure.RateLimited]: CauseSubcategory.RateLimited,
  [ProviderFailure.QuotaExhausted]: CauseSubcategory.QuotaExhausted,
  [ProviderFailure.Unavailable]: CauseSubcategory.Unavailable,
};

const environmentSubcategories: Readonly<Record<string, CauseSubcategory>> = {
  [EnvironmentFailure.SetupFailed]: CauseSubcategory.SetupFailed,
  [EnvironmentFailure.CommandAbsent]: CauseSubcategory.CommandAbsent,
  [EnvironmentFailure.AffectedInvalid]: CauseSubcategory.AffectedInvalid,
  [EnvironmentFailure.AffectedTimeout]: CauseSubcategory.AffectedTimeout,
};

const modelFaultCodes: readonly string[] = [
  ...Object.values(TurnViolation),
  MERGE_MARKERS_LEFT,
];

function isTimedOut(detail: string | null, signals: StopSignals): boolean {
  if (detail === null) return signals.verification_timed_out;
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    return signals.verification_timed_out;
  }
  const parsed = stopDetailSchema.safeParse(value);
  return parsed.success
    ? parsed.data.verification.timed_out
    : signals.verification_timed_out;
}

function providerCauseOf(code: string | null): FailureCause {
  if (code === null) return unattributed([]);
  const subcategory = providerSubcategories[code];
  if (subcategory !== undefined)
    return attributed(CauseCategory.LlmProvider, subcategory);
  if (code === ProviderFailure.Unauthorized)
    return attributed(CauseCategory.Human, CauseSubcategory.Configuration);
  if (code === ProviderFailure.BadRequest)
    return unattributed([
      CauseCategory.WorkerAction,
      CauseCategory.Prompt,
      CauseCategory.LlmProvider,
    ]);
  return unattributed([]);
}

function environmentCauseOf(code: string | null): FailureCause {
  const subcategory =
    code === null ? undefined : environmentSubcategories[code];
  return subcategory === undefined
    ? unattributed([])
    : attributed(CauseCategory.Environment, subcategory);
}

function operationCauseOf(
  code: string | null,
  gitStep: GitStep | null,
): FailureCause {
  if (gitStep === GitStep.FetchBase || gitStep === GitStep.Push)
    return unattributed([
      CauseCategory.Infrastructure,
      CauseCategory.WorkerAction,
    ]);
  if (gitStep === GitStep.MergeBase)
    return unattributed([
      CauseCategory.WorkerAction,
      CauseCategory.Environment,
    ]);
  if (code === VERIFICATION_INFRASTRUCTURE_FAILED)
    return attributed(
      CauseCategory.Infrastructure,
      CauseSubcategory.VerificationKilled,
    );
  if (code?.startsWith(BINDING_CODE_PREFIX))
    return attributed(CauseCategory.Human, CauseSubcategory.Configuration);
  if (code === GIT_COMMIT_FAILED)
    return unattributed([
      CauseCategory.WorkerAction,
      CauseCategory.Environment,
    ]);
  if (code !== null && modelFaultCodes.includes(code))
    return unattributed([CauseCategory.Model, CauseCategory.Prompt]);
  if (code?.startsWith(WORKER_CODE_PREFIX))
    return unattributed([
      CauseCategory.WorkerAction,
      CauseCategory.Infrastructure,
    ]);
  if (code === null || code.startsWith(GATEWAY_CODE_PREFIX))
    return unattributed([
      CauseCategory.Infrastructure,
      CauseCategory.WorkerAction,
    ]);
  return unattributed([]);
}

function noProgressCauseOf(timedOut: boolean): FailureCause {
  return timedOut
    ? unattributed([CauseCategory.Environment, CauseCategory.Plan])
    : unattributed([
        CauseCategory.Model,
        CauseCategory.Prompt,
        CauseCategory.Plan,
      ]);
}

function budgetCauseOf(timedOut: boolean): FailureCause {
  return timedOut
    ? unattributed([
        CauseCategory.Environment,
        CauseCategory.Plan,
        CauseCategory.Model,
      ])
    : unattributed([CauseCategory.Plan, CauseCategory.Model]);
}

export function stopCauseOf(
  reason: ExecutionStopReason,
  code: string | null,
  detail: string | null,
  signals: StopSignals,
): FailureCause {
  switch (reason) {
    case ExecutionStopReason.ProviderFailed:
      return providerCauseOf(code);
    case ExecutionStopReason.EnvironmentFailed:
      return environmentCauseOf(code);
    case ExecutionStopReason.OperationFailed:
      return operationCauseOf(code, signals.git_step);
    case ExecutionStopReason.NoProgress:
      return noProgressCauseOf(isTimedOut(detail, signals));
    case ExecutionStopReason.BudgetEnd:
    case ExecutionStopReason.AssessmentAbsent:
      return budgetCauseOf(isTimedOut(detail, signals));
    case ExecutionStopReason.JudgementInvalid:
    case ExecutionStopReason.ReportAbsent:
      return unattributed([CauseCategory.Model, CauseCategory.Prompt]);
    case ExecutionStopReason.ActionUnsettled:
      return unattributed([
        CauseCategory.WorkerAction,
        CauseCategory.Infrastructure,
      ]);
  }
}
