import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { getAgentDeclaration } from "./catalog.ts";
import {
  InstructionFileState,
  PromptLayer,
  PromptOrigin,
  PromptPart,
  type PromptPartAnswer,
  PromptPartState,
  type PromptReference,
  promptReferenceSchema,
} from "./contract.ts";
import { WORKBENCH_PROMPT } from "./prompt-assets.ts";
import { digest } from "./prompt-composer.ts";
import { framingPart, resolveAgentPrompt } from "./prompt-files.ts";
import {
  bindingParts,
  finalPrompt,
  PromptConsumer,
  systemPrompt,
} from "./prompt-render.ts";
import {
  type InstructionFileRead,
  type PromptReaders,
  resolvePrompt,
  resolveReference,
} from "./prompt-resolve.ts";
import {
  resolveTemplateSet,
  SHIPPED_TEMPLATE_SET,
} from "./prompt-templates.ts";

const AGENT = "swe@1";
const BINDING_ID = "binding_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const BINDING_NAME = "app";
const COMMIT = "c".repeat(40);
const INSTRUCTION_PATH = "AGENTS.md";
const INSTRUCTION_TEXT = "Write every name outside the code in snake_case.";
const BINDING_TEXT = "Keep each change small.";
const OVERRIDE_TEXT = "Write the smallest complete change.";

function referenceOf(part: PromptPartAnswer): PromptReference {
  return {
    part: part.part,
    name: part.name,
    origin: part.origin,
    path: part.path,
    binding_id: part.binding_id,
    commit: part.commit,
    digest: part.digest!,
  };
}

function readers(
  overrides: Partial<PromptReaders> = {},
  file: InstructionFileRead = {
    state: InstructionFileState.Present,
    text: INSTRUCTION_TEXT,
  },
): PromptReaders & { reads: string[] } {
  const reads: string[] = [];
  return {
    agentName: AGENT,
    bindingTextOf: (bindingId, part, agentName) =>
      bindingId === BINDING_ID &&
      part === PromptPart.Binding &&
      agentName === AGENT
        ? BINDING_TEXT
        : null,
    instructionFileOf: async (bindingId, commit, path) => {
      reads.push(`${bindingId}:${commit}:${path}`);
      return file;
    },
    context: background,
    ...overrides,
    reads,
  };
}

const instructionReference: PromptReference = {
  part: PromptPart.InstructionFile,
  name: BINDING_NAME,
  origin: PromptOrigin.Repository,
  path: INSTRUCTION_PATH,
  binding_id: BINDING_ID,
  commit: COMMIT,
  digest: digest(INSTRUCTION_TEXT),
};

const bindingReference: PromptReference = {
  part: PromptPart.Binding,
  name: BINDING_NAME,
  origin: PromptOrigin.Database,
  path: null,
  binding_id: BINDING_ID,
  commit: null,
  digest: digest(BINDING_TEXT),
};

test("the references of a composition resolve to the composed text", async (t) => {
  const directory = temporary(t);
  writeFileSync(join(directory, `${AGENT}.md`), OVERRIDE_TEXT);
  mkdirSync(join(directory, "prompts"));
  writeFileSync(
    join(directory, "prompts", "framing-worker.md"),
    "Custom framing.\n",
  );
  const templates = await resolveTemplateSet(
    join(directory, "prompts"),
    background,
  );
  const composed = [
    ...(await resolveAgentPrompt({
      agent: getAgentDeclaration(AGENT)!,
      directory,
      workbench: false,
      context: background,
    })),
    ...bindingParts(
      [
        {
          binding_id: BINDING_ID,
          name: BINDING_NAME,
          prompts: { agents: { [AGENT]: BINDING_TEXT } },
        },
      ],
      AGENT,
    ),
    framingPart(templates, PromptConsumer.Worker, directory),
  ];
  assert.deepEqual(
    composed.map(({ part, origin }) => [part, origin]),
    [
      [PromptPart.Standard, PromptOrigin.Binary],
      [PromptPart.Role, PromptOrigin.File],
      [PromptPart.Binding, PromptOrigin.Database],
      [PromptPart.Framing, PromptOrigin.File],
    ],
  );
  const answer = await resolvePrompt(composed.map(referenceOf), readers());
  assert.deepEqual(answer.parts, composed);
  assert.equal(answer.final, finalPrompt(composed));
  assert.equal(
    answer.final,
    systemPrompt(
      composed.slice(0, -1),
      PromptConsumer.Worker,
      templates.templates,
    ),
  );
});

test("each origin resolves its text and its layer and heading", async () => {
  const shipped = framingPart(
    SHIPPED_TEMPLATE_SET,
    PromptConsumer.Workbench,
    null,
  );
  const source = readers();
  const answer = await resolvePrompt(
    [
      {
        part: PromptPart.Standard,
        name: "base.md",
        origin: PromptOrigin.Binary,
        path: null,
        binding_id: null,
        commit: null,
        digest: (
          await resolveAgentPrompt({
            agent: getAgentDeclaration(AGENT)!,
            directory: null,
            workbench: false,
            context: background,
          })
        )[0]!.digest!,
      },
      {
        part: PromptPart.Workbench,
        name: "workbench.md",
        origin: PromptOrigin.Binary,
        path: null,
        binding_id: null,
        commit: null,
        digest: digest(WORKBENCH_PROMPT),
      },
      instructionReference,
      bindingReference,
      referenceOf(shipped),
    ],
    source,
  );
  assert.deepEqual(
    answer.parts.map(({ layer, part, heading, state }) => [
      layer,
      part,
      heading,
      state,
    ]),
    [
      [
        PromptLayer.KanthorD,
        PromptPart.Standard,
        null,
        PromptPartState.Resolved,
      ],
      [
        PromptLayer.KanthorD,
        PromptPart.Workbench,
        null,
        PromptPartState.Resolved,
      ],
      [
        PromptLayer.Repository,
        PromptPart.InstructionFile,
        `Repository prompt of repository ${BINDING_NAME}, file ${INSTRUCTION_PATH}:`,
        PromptPartState.Resolved,
      ],
      [
        PromptLayer.Binding,
        PromptPart.Binding,
        `Binding prompt of repository ${BINDING_NAME}:`,
        PromptPartState.Resolved,
      ],
      [null, PromptPart.Framing, null, PromptPartState.Resolved],
    ],
  );
  assert.deepEqual(source.reads, [
    `${BINDING_ID}:${COMMIT}:${INSTRUCTION_PATH}`,
  ]);
  assert.equal(answer.parts[1]!.text, WORKBENCH_PROMPT);
  assert.equal(answer.parts[2]!.text, INSTRUCTION_TEXT);
  assert.equal(answer.parts[3]!.text, BINDING_TEXT);
  assert.equal(answer.parts[4]!.text, shipped.text);
  assert.ok(
    answer.final!.includes(
      `Repository prompt of repository ${BINDING_NAME}, file ${INSTRUCTION_PATH}:\n\n${INSTRUCTION_TEXT}\n\nBinding prompt of repository ${BINDING_NAME}:\n\n${BINDING_TEXT}`,
    ),
  );
  const stored = await resolveReference(
    {
      ...bindingReference,
      part: PromptPart.Repository,
      digest: digest(INSTRUCTION_TEXT),
    },
    readers({ bindingTextOf: () => INSTRUCTION_TEXT }),
  );
  assert.deepEqual(
    [stored.layer, stored.heading, stored.state, stored.text],
    [
      PromptLayer.Repository,
      `Repository prompt of repository ${BINDING_NAME}, set in KanthorD:`,
      PromptPartState.Resolved,
      INSTRUCTION_TEXT,
    ],
  );
});

test("a text whose digest or source changed resolves as changed with no text and no final", async (t) => {
  const directory = temporary(t);
  const path = join(directory, `${AGENT}.md`);
  writeFileSync(path, OVERRIDE_TEXT);
  const [, role] = await resolveAgentPrompt({
    agent: getAgentDeclaration(AGENT)!,
    directory,
    workbench: false,
    context: background,
  });
  assert.equal(role!.origin, PromptOrigin.File);
  writeFileSync(path, `${OVERRIDE_TEXT} Edited.`);
  const edited = await resolveReference(referenceOf(role!), readers());
  assert.deepEqual(
    [edited.state, edited.text, edited.digest],
    [PromptPartState.Changed, null, role!.digest],
  );
  rmSync(path);
  assert.equal(
    (await resolveReference(referenceOf(role!), readers())).state,
    PromptPartState.Changed,
  );
  const changed = [
    {
      ...referenceOf(role!),
      origin: PromptOrigin.Binary,
    },
    { ...bindingReference, digest: digest("Another text.") },
    { ...bindingReference, binding_id: "binding_other" },
    {
      ...instructionReference,
      digest: digest("Another instruction file."),
    },
    { ...referenceOf(role!), origin: PromptOrigin.Binary, name: "x@1.md" },
    {
      ...referenceOf(
        framingPart(SHIPPED_TEMPLATE_SET, PromptConsumer.Worker, null),
      ),
      name: "work",
    },
  ];
  for (const reference of changed) {
    const part = await resolveReference(reference, readers());
    assert.deepEqual([part.state, part.text], [PromptPartState.Changed, null]);
  }
  const absent = await resolveReference(
    instructionReference,
    readers({}, { state: InstructionFileState.Absent }),
  );
  assert.equal(absent.state, PromptPartState.Changed);
  const answer = await resolvePrompt(
    [
      { ...bindingReference, digest: digest("Another text.") },
      referenceOf(
        framingPart(SHIPPED_TEMPLATE_SET, PromptConsumer.Worker, null),
      ),
    ],
    readers(),
  );
  assert.equal(answer.final, null);
  assert.equal(answer.parts[1]!.state, PromptPartState.Resolved);
});

test("an invalid source resolves as invalid and an unreachable remote as unreachable", async (t) => {
  const directory = temporary(t);
  const path = join(directory, `${AGENT}.md`);
  writeFileSync(path, OVERRIDE_TEXT);
  mkdirSync(join(directory, "prompts"));
  const framingPath = join(directory, "prompts", "framing-worker.md");
  writeFileSync(framingPath, "Custom framing.");
  const [, role] = await resolveAgentPrompt({
    agent: getAgentDeclaration(AGENT)!,
    directory,
    workbench: false,
    context: background,
  });
  const framing = framingPart(
    await resolveTemplateSet(join(directory, "prompts"), background),
    PromptConsumer.Worker,
    directory,
  );
  writeFileSync(path, "bell\u0007");
  writeFileSync(framingPath, "{{#if}}");
  for (const reference of [referenceOf(role!), referenceOf(framing)]) {
    const part = await resolveReference(reference, readers());
    assert.deepEqual([part.state, part.text], [PromptPartState.Invalid, null]);
  }
  const invalid = await resolveReference(
    instructionReference,
    readers({}, { state: InstructionFileState.Invalid }),
  );
  assert.deepEqual(
    [invalid.state, invalid.text, invalid.heading],
    [
      PromptPartState.Invalid,
      null,
      `Repository prompt of repository ${BINDING_NAME}, file ${INSTRUCTION_PATH}:`,
    ],
  );
  const unreachable = await resolvePrompt(
    [
      instructionReference,
      referenceOf(
        framingPart(SHIPPED_TEMPLATE_SET, PromptConsumer.Worker, null),
      ),
    ],
    readers({}, { state: InstructionFileState.Unreachable }),
  );
  assert.deepEqual(
    [unreachable.parts[0]!.state, unreachable.parts[0]!.text],
    [PromptPartState.Unreachable, null],
  );
  assert.equal(unreachable.final, null);
});

test("an override template whose text equals the shipped text reports origin file", async (t) => {
  const directory = temporary(t);
  mkdirSync(join(directory, "prompts"));
  const path = join(directory, "prompts", "framing-worker.md");
  writeFileSync(path, SHIPPED_TEMPLATE_SET.templates["framing-worker"]);
  const part = framingPart(
    await resolveTemplateSet(join(directory, "prompts"), background),
    PromptConsumer.Worker,
    directory,
  );
  const shipped = framingPart(
    SHIPPED_TEMPLATE_SET,
    PromptConsumer.Worker,
    directory,
  );
  assert.deepEqual(
    [part.origin, part.path, part.digest],
    [PromptOrigin.File, path, shipped.digest],
  );
  assert.equal(shipped.origin, PromptOrigin.Binary);
  assert.equal(
    (await resolveReference(referenceOf(part), readers())).state,
    PromptPartState.Resolved,
  );
});

test("a reference accepts a SHA-1 or a SHA-256 commit and refuses another length", () => {
  for (const commit of [COMMIT, "d".repeat(64)])
    assert.equal(
      promptReferenceSchema.safeParse({ ...instructionReference, commit })
        .success,
      true,
    );
  for (const commit of ["e".repeat(41), "f".repeat(39), "g".repeat(40)])
    assert.equal(
      promptReferenceSchema.safeParse({ ...instructionReference, commit })
        .success,
      false,
    );
});

test("the resolved swe@1 prompt forbids a merge of another branch and the resolved re@1 prompt blocks content outside the requirement", async () => {
  const roleText = async (agentName: string) => {
    const parts = await resolveAgentPrompt({
      agent: getAgentDeclaration(agentName)!,
      directory: null,
      workbench: false,
      context: background,
    });
    const role = await resolveReference(referenceOf(parts[1]!), readers());
    return role.text;
  };
  assert.ok(
    (await roleText("swe@1"))!.includes(
      "**Merge no branch.** Merge, rebase or cherry-pick no other branch into the node branch. The worker merges the base branch itself.",
    ),
  );
  assert.ok(
    (await roleText("re@1"))!.includes(
      "A change in the diff that the requirement and the tasks do not ask for is a blocker, also when a merge of another branch brings it in.",
    ),
  );
});
