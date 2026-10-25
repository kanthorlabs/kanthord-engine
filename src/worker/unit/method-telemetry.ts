import assert from "node:assert/strict";
import { SpanStatus, type Attributes } from "../../tracking/contract.ts";
import type { TaskContent } from "../../mission/contract.ts";
import {
  SpanOperation,
  type Phase,
  type SpanEnd,
  type SpanRecorder,
  type SpanStart,
} from "./telemetry.ts";
import type {
  CommandObserver,
  CommandRun,
  TestedInput,
} from "./verification.ts";
import type { ExecutionEnvironment } from "../contract.ts";
import { CodedError, diagnostic, diagnosticRows } from "../../kernel/errors.ts";
import { markGitStep, type GitStep } from "./git-step.ts";
import { noProgressAttributes } from "./progress-rule.ts";
import type { EvaluationFacts } from "./rework-cause.ts";

const SUCCESS = 0;
const NO_LENGTH = 0;
const COMMIT_INPUT_KIND = "repository";
const DIGEST_SEPARATOR = ",";

export function phaseSpan(phase: Phase): SpanStart {
  assert.ok(phase);
  const span = {
    key: `phase:${phase}`,
    operation: SpanOperation.Phase,
    attributes: { "kanthord.phase": phase },
  };
  assert.ok(span.key);
  return span;
}

export { GitStep } from "./git-step.ts";

export function gitFailure(error: unknown): SpanEnd {
  const line =
    error instanceof CodedError
      ? `${error.code}: ${error.cause instanceof Error ? error.cause.message : error.message}`
      : diagnostic(error);
  const text = `${line}\n${diagnosticRows(error)}`.trimEnd();
  return { status: SpanStatus.Error, texts: { error: text } };
}

export function withinGit<T>(
  spans: SpanRecorder,
  step: GitStep,
  work: () => Promise<T>,
): Promise<T> {
  assert.ok(step);
  return spans.within(
    {
      key: spans.key(`${SpanOperation.Git}:${step}`),
      operation: SpanOperation.Git,
      attributes: { "kanthord.git.step": step },
    },
    async () => {
      try {
        return await work();
      } catch (error) {
        markGitStep(error, step);
        throw error;
      }
    },
    () => ({ status: SpanStatus.Ok }),
    gitFailure,
  );
}

export function taskSpan(spans: SpanRecorder, task: TaskContent): SpanStart {
  assert.ok(task.id);
  const key = spans.key(SpanOperation.Task);
  assert.ok(key);
  return {
    key,
    operation: SpanOperation.Task,
    attributes: { "kanthord.task.id": task.id },
  };
}

export function taskEnd(result: { kind: string }): SpanEnd {
  assert.ok(result.kind);
  const end = {
    status: SpanStatus.Ok,
    attributes: { "kanthord.task.result": result.kind },
  };
  assert.ok(end.attributes["kanthord.task.result"]);
  return end;
}

export function taskFailure(error: unknown): SpanEnd {
  return { status: SpanStatus.Error, attributes: noProgressAttributes(error) };
}

function commandEnd(ran: CommandRun): SpanEnd {
  assert.ok(ran.result.command);
  const attributes: Attributes = {
    "kanthord.verification.timed_out": ran.result.timed_out,
  };
  if (ran.result.exit_code !== null)
    attributes["process.exit.code"] = ran.result.exit_code;
  if (ran.result.signal !== null)
    attributes["kanthord.verification.signal"] = ran.result.signal;
  assert.ok(Object.keys(attributes).length > NO_LENGTH);
  return {
    status: ran.result.exit_code === SUCCESS ? SpanStatus.Ok : SpanStatus.Error,
    attributes,
    texts: { output: ran.output },
  };
}

export function environmentDigestsOf(
  repositories: ReadonlyArray<{ environment: ExecutionEnvironment }>,
): string[] {
  return repositories.flatMap(({ environment }) =>
    environment === null || !("digest" in environment)
      ? []
      : [environment.digest],
  );
}

export function verificationObserver(
  spans: SpanRecorder,
  commit: string | null,
  digests: readonly string[],
): CommandObserver {
  assert.ok(spans);
  assert.ok(commit === null || commit.length > NO_LENGTH);
  return (attempt, execute) =>
    spans.within(
      {
        key: spans.key(SpanOperation.Verification),
        operation: SpanOperation.Verification,
        attributes: {
          ...(commit === null ? {} : { "kanthord.commit": commit }),
          ...(digests.length === NO_LENGTH
            ? {}
            : { "environment.digest": digests.join(DIGEST_SEPARATOR) }),
          "kanthord.verification.index": attempt.index,
          "kanthord.verification.run": attempt.run,
        },
        texts: { command: attempt.command },
      },
      execute,
      commandEnd,
    );
}

export function testedCommitOf(tested: TestedInput): string | null {
  assert.ok(tested);
  if (Array.isArray(tested)) return null;
  const commit = tested.kind === COMMIT_INPUT_KIND ? tested.commit : null;
  assert.ok(commit === null || commit.length > NO_LENGTH);
  return commit;
}

export function evaluationSpan(
  spans: SpanRecorder,
  commit: string | null,
): SpanStart {
  assert.ok(spans);
  assert.ok(commit === null || commit.length > NO_LENGTH);
  return {
    key: spans.key(SpanOperation.Evaluation),
    operation: SpanOperation.Evaluation,
    attributes: commit === null ? {} : { "kanthord.commit": commit },
  };
}

export const EvaluationAttribute = {
  Result: "kanthord.evaluation.result",
  Stage: "kanthord.evaluation.stage",
  UnmetIds: "kanthord.evaluation.unmet_ids",
  UnmetGrounds: "kanthord.evaluation.unmet_grounds",
  ProposalCount: "kanthord.evaluation.proposal_count",
  Repaired: "kanthord.judgement.repaired",
} as const;

export function evaluationEnd(judgement: {
  result: string;
  rationale: string;
  facts: EvaluationFacts;
}): SpanEnd {
  assert.ok(judgement.result);
  assert.ok(judgement.rationale);
  const { facts } = judgement;
  return {
    status: SpanStatus.Ok,
    attributes: {
      [EvaluationAttribute.Result]: judgement.result,
      [EvaluationAttribute.Stage]: facts.stage,
      [EvaluationAttribute.UnmetIds]: facts.unmet_ids,
      [EvaluationAttribute.UnmetGrounds]: facts.unmet_grounds,
      [EvaluationAttribute.ProposalCount]: facts.proposal_count,
      ...(facts.repaired === null
        ? {}
        : { [EvaluationAttribute.Repaired]: facts.repaired }),
    },
    texts: { rationale: judgement.rationale },
  };
}
