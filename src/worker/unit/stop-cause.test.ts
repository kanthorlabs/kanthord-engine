import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attributed,
  CauseCategory,
  CauseSubcategory,
  unattributed,
} from "../../kernel/cause.ts";
import {
  BudgetLimit,
  EnvironmentFailure,
  ExecutionStopReason,
  ProviderFailure,
} from "../../scheduler/contract.ts";
import { AgentErrorCode, PromptSourceReason } from "../../agent/contract.ts";
import { ProjectErrorCode } from "../../project/contract.ts";
import { WorkerErrorCode } from "../contract.ts";
import { GitStep } from "./git-step.ts";
import {
  codedStopDetail,
  stopCauseOf,
  type StopSignals,
} from "./stop-cause.ts";
import {
  GIT_COMMIT_FAILED,
  MERGE_MARKERS_LEFT,
  TurnViolation,
  VERIFICATION_INFRASTRUCTURE_FAILED,
} from "./stop-codes.ts";

const QUIET: StopSignals = { git_step: null, verification_timed_out: false };
const TIMED_OUT_SIGNALS: StopSignals = {
  git_step: null,
  verification_timed_out: true,
};

function timedOutDetail(timedOut: boolean): string {
  return JSON.stringify({
    rule: "verdict_rule_unmet",
    verification: { passed: false, ran: 1, exit_code: 1, timed_out: timedOut },
  });
}

test("a provider failure maps to the provider, the configuration or the suspects", () => {
  for (const [code, subcategory] of [
    [ProviderFailure.RateLimited, CauseSubcategory.RateLimited],
    [ProviderFailure.QuotaExhausted, CauseSubcategory.QuotaExhausted],
    [ProviderFailure.Unavailable, CauseSubcategory.Unavailable],
  ] as const)
    assert.deepEqual(
      stopCauseOf(ExecutionStopReason.ProviderFailed, code, null, QUIET),
      attributed(CauseCategory.LlmProvider, subcategory),
    );
  assert.deepEqual(
    stopCauseOf(
      ExecutionStopReason.ProviderFailed,
      ProviderFailure.Unauthorized,
      null,
      QUIET,
    ),
    attributed(CauseCategory.Human, CauseSubcategory.Configuration),
  );
  assert.deepEqual(
    stopCauseOf(
      ExecutionStopReason.ProviderFailed,
      ProviderFailure.BadRequest,
      null,
      QUIET,
    ),
    unattributed([
      CauseCategory.WorkerAction,
      CauseCategory.Prompt,
      CauseCategory.LlmProvider,
    ]),
  );
});

test("an environment failure maps to the environment with its code", () => {
  assert.deepEqual(
    stopCauseOf(
      ExecutionStopReason.EnvironmentFailed,
      EnvironmentFailure.SetupFailed,
      null,
      QUIET,
    ),
    attributed(CauseCategory.Environment, CauseSubcategory.SetupFailed),
  );
  assert.deepEqual(
    stopCauseOf(
      ExecutionStopReason.EnvironmentFailed,
      EnvironmentFailure.CommandAbsent,
      null,
      QUIET,
    ),
    attributed(CauseCategory.Environment, CauseSubcategory.CommandAbsent),
  );
  assert.deepEqual(
    stopCauseOf(
      ExecutionStopReason.EnvironmentFailed,
      EnvironmentFailure.AffectedInvalid,
      null,
      QUIET,
    ),
    attributed(CauseCategory.Environment, CauseSubcategory.AffectedInvalid),
  );
  assert.deepEqual(
    stopCauseOf(
      ExecutionStopReason.EnvironmentFailed,
      EnvironmentFailure.AffectedTimeout,
      null,
      QUIET,
    ),
    attributed(CauseCategory.Environment, CauseSubcategory.AffectedTimeout),
  );
  assert.deepEqual(
    stopCauseOf(
      ExecutionStopReason.EnvironmentFailed,
      EnvironmentFailure.VerificationTimeout,
      null,
      QUIET,
    ),
    attributed(CauseCategory.Environment, CauseSubcategory.VerificationHang),
  );
});

test("an operation failure with a git step maps to the suspects of the step", () => {
  for (const step of [GitStep.FetchBase, GitStep.Push])
    assert.deepEqual(
      stopCauseOf(ExecutionStopReason.OperationFailed, null, null, {
        ...QUIET,
        git_step: step,
      }),
      unattributed([CauseCategory.Infrastructure, CauseCategory.WorkerAction]),
    );
  assert.deepEqual(
    stopCauseOf(ExecutionStopReason.OperationFailed, null, null, {
      ...QUIET,
      git_step: GitStep.MergeBase,
    }),
    unattributed([CauseCategory.WorkerAction, CauseCategory.Environment]),
  );
});

test("a git step wins over the code of an operation failure", () => {
  assert.deepEqual(
    stopCauseOf(
      ExecutionStopReason.OperationFailed,
      VERIFICATION_INFRASTRUCTURE_FAILED,
      null,
      { ...QUIET, git_step: GitStep.Push },
    ),
    unattributed([CauseCategory.Infrastructure, CauseCategory.WorkerAction]),
  );
});

test("a prompt setup stop maps by its code and its stop detail", () => {
  const operation = (code: string, detail: string | null = null) =>
    stopCauseOf(ExecutionStopReason.OperationFailed, code, detail, QUIET);
  const promptRecord = attributed(
    CauseCategory.Infrastructure,
    CauseSubcategory.PromptRecord,
  );
  assert.deepEqual(
    operation(AgentErrorCode.PromptSourceInvalid, PromptSourceReason.Changed),
    promptRecord,
  );
  for (const reason of [
    PromptSourceReason.TooLarge,
    PromptSourceReason.NotUtf8,
    PromptSourceReason.Unreadable,
    PromptSourceReason.ControlCharacter,
  ])
    assert.deepEqual(
      operation(AgentErrorCode.PromptSourceInvalid, reason),
      attributed(CauseCategory.Prompt, CauseSubcategory.SourceInvalid),
    );
  for (const code of [
    WorkerErrorCode.ExecutionPromptNotPinned,
    WorkerErrorCode.ExecutionPromptRecordFailed,
  ])
    assert.deepEqual(operation(code), promptRecord);
  assert.deepEqual(
    operation(ProjectErrorCode.RepositorySshUnreachable),
    attributed(CauseCategory.Infrastructure, CauseSubcategory.Network),
  );
  assert.deepEqual(
    operation(ProjectErrorCode.RepositoryBaseBranchAbsent),
    attributed(CauseCategory.Human, CauseSubcategory.Configuration),
  );
});

test("a source_invalid error gives its details reason as the stop detail", () => {
  assert.equal(
    codedStopDetail(AgentErrorCode.PromptSourceInvalid, {
      part: "instruction_file",
      reason: PromptSourceReason.Changed,
    }),
    PromptSourceReason.Changed,
  );
  assert.equal(
    codedStopDetail(WorkerErrorCode.ExecutionPromptNotPinned, {
      reason: PromptSourceReason.Changed,
    }),
    null,
  );
  assert.equal(codedStopDetail(AgentErrorCode.PromptSourceInvalid, null), null);
});

test("an operation failure maps by its code", () => {
  const operation = (code: string | null) =>
    stopCauseOf(ExecutionStopReason.OperationFailed, code, null, QUIET);
  assert.deepEqual(
    operation(VERIFICATION_INFRASTRUCTURE_FAILED),
    attributed(
      CauseCategory.Infrastructure,
      CauseSubcategory.VerificationKilled,
    ),
  );
  assert.deepEqual(
    operation("project.binding.unreadable"),
    attributed(CauseCategory.Human, CauseSubcategory.Configuration),
  );
  assert.deepEqual(
    operation(GIT_COMMIT_FAILED),
    unattributed([CauseCategory.WorkerAction, CauseCategory.Environment]),
  );
  for (const code of [...Object.values(TurnViolation), MERGE_MARKERS_LEFT])
    assert.deepEqual(
      operation(code),
      unattributed([CauseCategory.Model, CauseCategory.Prompt]),
    );
  assert.deepEqual(
    operation("worker.other.failed"),
    unattributed([CauseCategory.WorkerAction, CauseCategory.Infrastructure]),
  );
  for (const code of ["gateway.request.failed", null])
    assert.deepEqual(
      operation(code),
      unattributed([CauseCategory.Infrastructure, CauseCategory.WorkerAction]),
    );
  assert.deepEqual(operation("scheduler.other.failed"), unattributed([]));
});

test("a no-progress stop reads the timeout from its detail", () => {
  const noProgress = (detail: string | null, signals = QUIET) =>
    stopCauseOf(ExecutionStopReason.NoProgress, null, detail, signals);
  assert.deepEqual(
    noProgress(timedOutDetail(true)),
    unattributed([CauseCategory.Environment, CauseCategory.Plan]),
  );
  const unmet = unattributed([
    CauseCategory.Model,
    CauseCategory.Prompt,
    CauseCategory.Plan,
  ]);
  assert.deepEqual(noProgress(timedOutDetail(false)), unmet);
  assert.deepEqual(noProgress(timedOutDetail(false), TIMED_OUT_SIGNALS), unmet);
  assert.deepEqual(noProgress(null), unmet);
});

test("a budget end and an absent assessment use the signal when the detail names no verification", () => {
  for (const reason of [
    ExecutionStopReason.BudgetEnd,
    ExecutionStopReason.AssessmentAbsent,
  ]) {
    assert.deepEqual(
      stopCauseOf(reason, BudgetLimit.Turns, null, QUIET),
      unattributed([CauseCategory.Plan, CauseCategory.Model]),
    );
    const timedOut = unattributed([
      CauseCategory.Environment,
      CauseCategory.Plan,
      CauseCategory.Model,
    ]);
    assert.deepEqual(
      stopCauseOf(reason, BudgetLimit.Turns, null, TIMED_OUT_SIGNALS),
      timedOut,
    );
    assert.deepEqual(
      stopCauseOf(reason, null, "not json", TIMED_OUT_SIGNALS),
      timedOut,
    );
    assert.deepEqual(
      stopCauseOf(reason, null, '{"verification":null}', TIMED_OUT_SIGNALS),
      timedOut,
    );
    assert.deepEqual(
      stopCauseOf(reason, null, timedOutDetail(true), QUIET),
      timedOut,
    );
  }
});

test("the other stops map to their suspects", () => {
  for (const reason of [
    ExecutionStopReason.JudgementInvalid,
    ExecutionStopReason.ReportAbsent,
  ])
    assert.deepEqual(
      stopCauseOf(reason, null, null, QUIET),
      unattributed([CauseCategory.Model, CauseCategory.Prompt]),
    );
  assert.deepEqual(
    stopCauseOf(ExecutionStopReason.ActionUnsettled, null, null, QUIET),
    unattributed([CauseCategory.WorkerAction, CauseCategory.Infrastructure]),
  );
});

test("a stop that no row names is unattributed with no suspects", () => {
  assert.deepEqual(
    stopCauseOf(ExecutionStopReason.ProviderFailed, "other", null, QUIET),
    unattributed([]),
  );
  assert.deepEqual(
    stopCauseOf(ExecutionStopReason.EnvironmentFailed, "other", null, QUIET),
    unattributed([]),
  );
});

test("an operator stop maps to the human intervention", () => {
  for (const reason of [
    ExecutionStopReason.InstanceArchived,
    ExecutionStopReason.WorkerStopped,
  ])
    assert.deepEqual(
      stopCauseOf(reason, null, null, QUIET),
      attributed(CauseCategory.Human, CauseSubcategory.Intervention),
    );
});
