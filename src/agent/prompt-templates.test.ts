import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  AgentErrorCode,
  PromptTemplate,
  promptTemplatesSchema,
} from "./contract.ts";
import { renderWorkPrompt } from "./prompt-composer.ts";
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
const NO_ENTRIES = 0;
const EXAMINE_RENDERED_TAIL =
  '\nDependencies: [{"id":"o"}]\nOutcomes: []\nEvidence: null\nFinal-snapshot verification: null';

function templateInvalid(path: string | null, reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, AgentErrorCode.PromptTemplateInvalid);
    assert.deepEqual(error.details, {
      template: PromptTemplate.CriterionRevision,
      file: `prompts/${PromptTemplate.CriterionRevision}.md`,
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

const CODER_ANSWER_TEMPLATES = ["task-judgement", "task-choice"];
const INVALID_SYNTAX = "{{#if}";

test("a template set with a coder answer template fails the strict schema", () => {
  assert.equal(
    promptTemplatesSchema.safeParse(SHIPPED_TEMPLATES).success,
    true,
  );
  for (const name of CODER_ANSWER_TEMPLATES)
    assert.equal(
      promptTemplatesSchema.safeParse({ ...SHIPPED_TEMPLATES, [name]: "" })
        .success,
      false,
      name,
    );
});

test("a coder answer template file of the directory is ignored", async (t) => {
  const directory = join(temporary(t), TEMPLATE_DIRECTORY);
  mkdirSync(directory);
  for (const name of CODER_ANSWER_TEMPLATES)
    writeFileSync(join(directory, `${name}.md`), INVALID_SYNTAX);
  assert.deepEqual(
    await resolveTemplates(directory, background),
    SHIPPED_TEMPLATES,
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
    renderTemplate(SHIPPED_TEMPLATES, PromptTemplate.Examine, {
      repositories: [],
      dependencies: [{ id: "o" }],
      outcomes: [],
      evidence: null,
      verification: null,
    }).endsWith(EXAMINE_RENDERED_TAIL),
    true,
  );
});

test("the examine template renders the dependencies and the repositories only when present", () => {
  const repositories = [
    { name: "first", directory: "first", base_branch: "main" },
    { name: "second", directory: "second", base_branch: "dev" },
  ];
  for (const listed of [[], repositories])
    for (const dependencies of [[], [{ id: "o" }]]) {
      const text = renderTemplate(SHIPPED_TEMPLATES, PromptTemplate.Examine, {
        repositories: listed,
        dependencies,
        outcomes: [],
        evidence: [],
        verification: null,
      });
      assert.equal(
        text.includes("Dependencies: "),
        dependencies.length > NO_ENTRIES,
      );
      assert.equal(
        text.includes(
          "Repository first: directory `first`, base branch `main`\nRepository second: directory `second`, base branch `dev`",
        ),
        listed.length > NO_ENTRIES,
      );
      assert.ok(text.endsWith("Final-snapshot verification: null"));
    }
});

const CONFLICT_RENDERED =
  "The merge of origin/main into the node branch of repository web in directory `web` conflicts. Resolve every conflict in these files of that directory so that the base branch change and the node work both stay intact: a.ts, b.ts. Remove every conflict marker. The worker commits. Do not abort the merge.";

test("the conflict template names the binding, the directory and the base branch", () => {
  assert.equal(
    renderTemplate(SHIPPED_TEMPLATES, PromptTemplate.Conflict, {
      binding: "web",
      directory: "web",
      base_branch: "main",
      files: "a.ts, b.ts",
    }),
    CONFLICT_RENDERED,
  );
});

test("the shipped work text renders the affected test line", () => {
  const { text } = renderWorkPrompt(SHIPPED_TEMPLATES, {
    node_id: "node",
    revision: 1,
    content: {
      name: "unit",
      requirement: "build",
      criterion: "passes",
      verifications: ["first"],
    },
    affected_tests: [
      { name: "engine", command: "pnpm --silent run test:affected" },
    ],
  });
  assert.ok(
    text.includes(
      "Repository engine: affected tests `pnpm --silent run test:affected`\n",
    ),
  );
});
