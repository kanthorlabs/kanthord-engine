import assert from "node:assert/strict";
import { test } from "node:test";
import { GitStep, gitStepOf, markGitStep } from "./git-step.ts";
import { withinGit } from "./method-telemetry.ts";
import { noTelemetry, SpanRecorder } from "./telemetry.ts";

const CLAIM = {
  execution_id: "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
  attempt: 1,
  trace_id: "a".repeat(32),
  root_span_id: "1".repeat(16),
};

test("a marked error answers its step", () => {
  const error = new Error("failed");
  markGitStep(error, GitStep.Commit);
  assert.equal(gitStepOf(error), GitStep.Commit);
});

test("a second mark keeps the first step", () => {
  const error = new Error("failed");
  markGitStep(error, GitStep.Commit);
  markGitStep(error, GitStep.Push);
  assert.equal(gitStepOf(error), GitStep.Commit);
});

test("an unmarked error and a string answer null", () => {
  markGitStep("failed", GitStep.Push);
  assert.equal(gitStepOf(new Error("failed")), null);
  assert.equal(gitStepOf("failed"), null);
});

test("an error thrown through withinGit answers its step", async () => {
  const spans = new SpanRecorder(CLAIM, "coder@1", noTelemetry);
  const error = new Error("push failed");
  await assert.rejects(
    withinGit(spans, GitStep.Push, () => Promise.reject(error)),
    (thrown) => thrown === error,
  );
  assert.equal(gitStepOf(error), GitStep.Push);
});
