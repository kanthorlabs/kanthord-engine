import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { getAgentDeclaration } from "./catalog.ts";
import { WorkerMethod } from "../worker/contract.ts";
import {
  composePrompt,
  renderWorkPrompt,
  type CompositionInput,
} from "./prompt-composer.ts";
import {
  InvalidReason,
  SourceState,
  PROMPT_SOURCE_MAX_BYTES,
} from "./prompt-source.ts";

test("composition observes source order, disabled layers, rejection and evaluator isolation", async (t) => {
  const hostFirst = "host first";
  const projectFirst = "project first";
  const operator = "operator";
  const projectConfigured = "project configured";
  const hostFallback = "host fallback";
  const projectFallback = "project fallback";
  const home = temporary(t);
  const workspace = join(home, "workspace");
  for (const directory of [
    workspace,
    join(home, ".agents"),
    join(home, ".claude"),
  ])
    mkdirSync(directory);
  const hostFile = join(home, ".agents/AGENTS.md");
  const projectFile = join(workspace, "AGENTS.md");
  writeFileSync(hostFile, "host first");
  writeFileSync(join(home, ".claude/CLAUDE.md"), "host fallback");
  writeFileSync(projectFile, "project first");
  writeFileSync(join(workspace, "CLAUDE.md"), "project fallback");
  const input: CompositionInput = {
    workerName: "general@1",
    agent: getAgentDeclaration("swe@1")!,
    method: WorkerMethod.Steps,
    globalPrompt: { state: SourceState.Absent },
    hostHome: home,
    repository: { name: "source", projectPrompt: null },
    workspace,
  };
  const compose = (overrides: Partial<CompositionInput> = {}) =>
    composePrompt({ ...input, ...overrides }, background);
  const first = await compose();
  assert.equal(first.layers.global?.text, hostFirst);
  assert.equal(first.layers.project?.text, projectFirst);
  const configured = await compose({
    globalPrompt: {
      state: SourceState.Present,
      path: "configured",
      text: "operator",
    },
    repository: { name: "source", projectPrompt: "project configured" },
  });
  assert.equal(configured.layers.global?.text, operator);
  assert.equal(configured.layers.project?.text, projectConfigured);
  const disabled = await compose({
    globalPrompt: { state: SourceState.Disabled },
    repository: { name: "source", projectPrompt: "-" },
  });
  assert.deepEqual(disabled.layers, { global: null, project: null });
  const invalid = await compose({
    globalPrompt: {
      state: SourceState.Invalid,
      path: "bad",
      reason: InvalidReason.Unreadable,
    },
  });
  assert.equal(invalid.layers.global, null);
  assert.equal(invalid.record.rejected[0]?.reason, InvalidReason.Unreadable);
  rmSync(hostFile);
  rmSync(projectFile);
  const fallback = await compose();
  assert.equal(fallback.layers.global?.text, hostFallback);
  assert.equal(fallback.layers.project?.text, projectFallback);
  writeFileSync(projectFile, "x".repeat(PROMPT_SOURCE_MAX_BYTES + 1));
  const oversized = await compose();
  assert.equal(oversized.layers.project, null);
  assert.equal(oversized.record.rejected[0]?.reason, InvalidReason.TooLarge);
  rmSync(projectFile);
  symlinkSync(join(home, ".claude/CLAUDE.md"), projectFile);
  assert.equal(
    (await compose()).record.rejected[0]?.reason,
    InvalidReason.OutsideWorkspace,
  );
  const evaluation = await compose({ method: WorkerMethod.Evaluation });
  assert.equal(evaluation.layers.project, null);
  assert.deepEqual(evaluation.record.rejected, []);
  const withNewline = await compose({
    globalPrompt: {
      state: SourceState.Present,
      path: "configured",
      text: "operator\n",
    },
  });
  assert.notEqual(
    configured.record.selected[0]?.digest,
    withNewline.record.selected[0]?.digest,
  );
  assert.doesNotMatch(JSON.stringify(configured.record), /"text":/);
  assert.deepEqual(
    configured.record.selected.map(({ layer }) => layer),
    ["global prompt", "base prompt", "agent prompt", "project prompt"],
  );
  assert.ok(
    configured.systemPrompt.indexOf("- global prompt") <
      configured.systemPrompt.indexOf("- base prompt"),
  );
});

test("work prompts retain commands and exact text with pinned ownership", () => {
  const work = renderWorkPrompt({
    nodeId: "node",
    revision: 3,
    content: {
      name: "unit",
      requirement: "build",
      criterion: "passes",
      verifications: ["first", "second"],
    },
  });
  assert.match(work.text, /1\. first\n2\. second$/);
  assert.match(work.marked, /owner="node revision 3 of node"/);
  assert.match(work.digest, /^[a-f0-9]{64}$/);
});
