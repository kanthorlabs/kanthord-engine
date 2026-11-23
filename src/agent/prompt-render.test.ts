import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PromptOrigin,
  PromptPart,
  type PromptPartAnswer,
  PromptPartState,
} from "./contract.ts";
import { digest } from "./prompt-composer.ts";
import {
  bindingParts,
  finalPrompt,
  framing,
  framingPartFromTemplates,
  PromptConsumer,
  promptPart,
} from "./prompt-render.ts";
import { SHIPPED_TEMPLATES } from "./prompt-templates.ts";

const STANDARD_TEXT = "Standard text.";
const ROLE_TEXT = "Role text.";
const WORKBENCH_TEXT = "Workbench text.";
const FILE_TEXT = "Instruction file text.\n";
const REPOSITORY_TEXT = "Repository text.";
const BINDING_TEXT = "Binding text.";
const AGENT = "swe@1";

function binaryPart(part: PromptPart, text: string): PromptPartAnswer {
  return promptPart(
    {
      part,
      name: part,
      origin: PromptOrigin.Binary,
      path: null,
      binding_id: null,
      commit: null,
      digest: digest(text),
    },
    PromptPartState.Resolved,
    text,
  );
}

function workerParts(fileText: string): PromptPartAnswer[] {
  return [
    binaryPart(PromptPart.Standard, STANDARD_TEXT),
    binaryPart(PromptPart.Role, ROLE_TEXT),
    ...bindingParts(
      [
        {
          binding_id: "binding",
          name: "repo",
          prompts: {
            repository: REPOSITORY_TEXT,
            agents: { [AGENT]: BINDING_TEXT },
          },
        },
      ],
      AGENT,
      new Map([
        [
          "binding",
          {
            state: PromptPartState.Resolved,
            path: "AGENTS.md",
            commit: "commit",
            text: fileText,
          },
        ],
      ]),
    ),
    framingPartFromTemplates(SHIPPED_TEMPLATES, PromptConsumer.Worker),
  ];
}

test("finalPrompt joins the golden worker parts as the join of today", () => {
  assert.equal(
    finalPrompt(workerParts(FILE_TEXT)),
    `${STANDARD_TEXT}\n\n${ROLE_TEXT}\n\nRepository prompt of repository repo, file AGENTS.md:\n\n${FILE_TEXT}\n\nRepository prompt of repository repo, set in KanthorD:\n\n${REPOSITORY_TEXT}\n\nBinding prompt of repository repo:\n\n${BINDING_TEXT}\n\n${framing(SHIPPED_TEMPLATES, PromptConsumer.Worker)}`,
  );
});

test("finalPrompt joins the Workbench parts and the Workbench framing as the join of today", () => {
  assert.equal(
    finalPrompt([
      binaryPart(PromptPart.Standard, STANDARD_TEXT),
      binaryPart(PromptPart.Role, ROLE_TEXT),
      binaryPart(PromptPart.Workbench, WORKBENCH_TEXT),
      framingPartFromTemplates(SHIPPED_TEMPLATES, PromptConsumer.Workbench),
    ]),
    `${STANDARD_TEXT}\n\n${ROLE_TEXT}\n\n${WORKBENCH_TEXT}\n\n${framing(SHIPPED_TEMPLATES, PromptConsumer.Workbench)}`,
  );
});

test("finalPrompt gives null for an unresolved part", () => {
  const parts = workerParts(FILE_TEXT);
  parts[2] = { ...parts[2]!, state: PromptPartState.Unreachable, text: null };
  assert.equal(finalPrompt(parts), null);
});

test("regression: finalPrompt keeps an empty instruction file as its heading", () => {
  assert.equal(
    finalPrompt(workerParts("")),
    `${STANDARD_TEXT}\n\n${ROLE_TEXT}\n\nRepository prompt of repository repo, file AGENTS.md:\n\n\n\nRepository prompt of repository repo, set in KanthorD:\n\n${REPOSITORY_TEXT}\n\nBinding prompt of repository repo:\n\n${BINDING_TEXT}\n\n${framing(SHIPPED_TEMPLATES, PromptConsumer.Worker)}`,
  );
});
