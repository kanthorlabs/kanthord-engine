import assert from "node:assert/strict";
import type { z } from "zod";
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
import { isString } from "../../kernel/values.ts";
import { CodedError, diagnostic } from "../../kernel/errors.ts";
import { ReplyRepair, type taskJudgementSchema } from "./judgement.ts";

const SUCCESS = 0;
const NO_LENGTH = 0;
const JUDGEMENT_PARSED = "parsed";
const COMMIT_INPUT_KIND = "repository";
type TaskJudgement = z.output<typeof taskJudgementSchema>;

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

export const GitStep = {
  Commit: "commit",
  SshProof: "ssh_proof",
  FetchBase: "fetch_base",
  MergeBase: "merge_base",
  Push: "push",
} as const;
export type GitStep = (typeof GitStep)[keyof typeof GitStep];

function gitFailure(error: unknown): SpanEnd {
  const text =
    error instanceof CodedError
      ? `${error.code}: ${error.cause instanceof Error ? error.cause.message : error.message}`
      : diagnostic(error);
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
    work,
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

export function verificationObserver(
  spans: SpanRecorder,
  commit: string | null,
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
          "kanthord.verification.index": attempt.index,
          "kanthord.verification.run": attempt.run,
        },
        texts: { command: attempt.command },
      },
      execute,
      commandEnd,
    );
}

export function judgementSpan(
  spans: SpanRecorder,
  task: TaskContent,
  commit: string | null,
): SpanStart {
  assert.ok(task.id);
  assert.ok(commit === null || commit.length > NO_LENGTH);
  return {
    key: spans.key(SpanOperation.Judgement),
    operation: SpanOperation.Judgement,
    attributes: {
      "kanthord.task.id": task.id,
      ...(commit === null ? {} : { "kanthord.commit": commit }),
    },
  };
}

export function judgementEnd(judgement: TaskJudgement | ReplyRepair): SpanEnd {
  assert.ok(judgement);
  if (isString(judgement))
    return {
      status:
        judgement === ReplyRepair.Invalid ? SpanStatus.Error : SpanStatus.Ok,
      attributes: { "kanthord.judgement.reply": judgement },
    };
  assert.ok(judgement.rationale);
  return {
    status: SpanStatus.Ok,
    attributes: {
      "kanthord.judgement.reply": JUDGEMENT_PARSED,
      "kanthord.judgement.criterion_met": judgement.criterion_met,
    },
    texts: { rationale: judgement.rationale },
  };
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

export function evaluationEnd(judgement: {
  result: string;
  rationale: string;
}): SpanEnd {
  assert.ok(judgement.result);
  assert.ok(judgement.rationale);
  return {
    status: SpanStatus.Ok,
    attributes: { "kanthord.evaluation.result": judgement.result },
    texts: { rationale: judgement.rationale },
  };
}
