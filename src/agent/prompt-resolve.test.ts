import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { getAgentDeclaration } from "./catalog.ts";
import {
  PromptLayer,
  PromptOrigin,
  PromptPart,
  type PromptPartAnswer,
  PromptPartState,
  type PromptReference,
} from "./contract.ts";
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
  InstructionFileState,
  type PromptReaders,
  resolvePrompt,
  resolveReference,
} from "./prompt-resolve.ts";
import { resolveTemplates, SHIPPED_TEMPLATES } from "./prompt-templates.ts";

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
    digest: part.digest,
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
  const templates = await resolveTemplates(
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
          prompts: { [AGENT]: BINDING_TEXT },
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
    systemPrompt(composed.slice(0, -1), PromptConsumer.Worker, templates),
  );
});

test("each origin resolves its text and its layer and heading", async () => {
  const shipped = framingPart(
    SHIPPED_TEMPLATES,
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
        )[0]!.digest,
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
  assert.equal(answer.parts[1]!.text, INSTRUCTION_TEXT);
  assert.equal(answer.parts[2]!.text, BINDING_TEXT);
  assert.equal(answer.parts[3]!.text, shipped.text);
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
        framingPart(SHIPPED_TEMPLATES, PromptConsumer.Worker, null),
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
      referenceOf(framingPart(SHIPPED_TEMPLATES, PromptConsumer.Worker, null)),
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
    await resolveTemplates(join(directory, "prompts"), background),
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
      referenceOf(framingPart(SHIPPED_TEMPLATES, PromptConsumer.Worker, null)),
    ],
    readers({}, { state: InstructionFileState.Unreachable }),
  );
  assert.deepEqual(
    [unreachable.parts[0]!.state, unreachable.parts[0]!.text],
    [PromptPartState.Unreachable, null],
  );
  assert.equal(unreachable.final, null);
});
