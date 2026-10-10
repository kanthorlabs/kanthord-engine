import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { temporary } from "../kernel/test-support.ts";
import { AgentErrorCode, PromptTemplate } from "./contract.ts";
import { InvalidReason, PROMPT_SOURCE_MAX_BYTES } from "./prompt-source.ts";
import {
  renderTemplate,
  resolveTemplates,
  SHIPPED_TEMPLATES,
  TEMPLATE_DIRECTORY,
  templateDirectory,
  TemplateInvalidReason,
} from "./prompt-templates.ts";

const OVERRIDE_TEXT = "Fix it: {{rationale}}\n";
const UNSAFE_RATIONALE = "<a & b>";
const OVERRIDE_RENDERED = `Fix it: ${UNSAFE_RATIONALE}`;
const REPORT_RENDERED =
  'Write a Markdown report on the outcome of each current objective using its outcome and evidence.\nObjectives: [{"id":"o"}]\nOutcomes: []\nEvidence: null';

function templateInvalid(path: string | null, reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, AgentErrorCode.PromptTemplateInvalid);
    assert.deepEqual(error.details, {
      template: PromptTemplate.CriterionRevision,
      path,
      reason,
    });
    return true;
  };
}

test("templates resolve to the shipped set without a directory or file", async (t) => {
  assert.equal(templateDirectory(null), null);
  assert.equal(
    templateDirectory("/data/agents"),
    join("/data/agents", TEMPLATE_DIRECTORY),
  );
  assert.equal(await resolveTemplates(null, background), SHIPPED_TEMPLATES);
  assert.deepEqual(
    await resolveTemplates(join(temporary(t), "missing"), background),
    SHIPPED_TEMPLATES,
  );
});

test("a template file of the directory replaces only its shipped template", async (t) => {
  const directory = join(temporary(t), TEMPLATE_DIRECTORY);
  mkdirSync(directory);
  writeFileSync(
    join(directory, `${PromptTemplate.CriterionRevision}.md`),
    OVERRIDE_TEXT,
  );
  const templates = await resolveTemplates(directory, background);
  assert.deepEqual(templates, {
    ...SHIPPED_TEMPLATES,
    [PromptTemplate.CriterionRevision]: OVERRIDE_TEXT,
  });
  assert.equal(
    renderTemplate(templates, PromptTemplate.CriterionRevision, {
      rationale: UNSAFE_RATIONALE,
    }),
    OVERRIDE_RENDERED,
  );
});

test("an invalid template file fails the resolution", async (t) => {
  const directory = temporary(t);
  const path = join(directory, `${PromptTemplate.CriterionRevision}.md`);
  writeFileSync(path, "x".repeat(PROMPT_SOURCE_MAX_BYTES + 1));
  await assert.rejects(
    resolveTemplates(directory, background),
    templateInvalid(path, InvalidReason.TooLarge),
  );
  writeFileSync(path, "{{#each rationale}}");
  await assert.rejects(
    resolveTemplates(directory, background),
    templateInvalid(path, TemplateInvalidReason.Syntax),
  );
  writeFileSync(path, "{{unknownHelper rationale}}");
  await assert.rejects(
    resolveTemplates(directory, background),
    templateInvalid(path, TemplateInvalidReason.Syntax),
  );
});

test("a render fails on a placeholder without a value", () => {
  const templates = {
    ...SHIPPED_TEMPLATES,
    [PromptTemplate.CriterionRevision]: "{{rationale}} {{missing}}",
  };
  assert.throws(
    () =>
      renderTemplate(templates, PromptTemplate.CriterionRevision, {
        rationale: "reason",
      }),
    templateInvalid(null, TemplateInvalidReason.Render),
  );
});

test("shipped templates render JSON values and drop the final newline", () => {
  assert.equal(
    renderTemplate(SHIPPED_TEMPLATES, PromptTemplate.Report, {
      objectives: [{ id: "o" }],
      outcomes: [],
      evidence: null,
    }),
    REPORT_RENDERED,
  );
});
