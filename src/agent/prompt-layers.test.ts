import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { getAgentDeclaration } from "./catalog.ts";
import {
  PromptLayerKind,
  PromptOrigin,
  PromptScope,
  PromptSourceState,
  PROMPT_SWITCHES,
  type StoredPromptSettings,
} from "./contract.ts";
import { BASE_PROMPT, WORKBENCH_PROMPT } from "./prompt-assets.ts";
import { digest } from "./prompt-composer.ts";
import {
  resolveLayers,
  resolveRepositoryLayer,
  type LayerInput,
  type PromptSettingsSet,
  type ResolvedLayer,
} from "./prompt-layers.ts";
import {
  compositionRecord,
  finalPrompt,
  framing,
  PromptConsumer,
  systemPrompt,
  workingTexts,
} from "./prompt-render.ts";
import { PROMPT_SOURCE_MAX_BYTES, InvalidReason } from "./prompt-source.ts";
import { SHIPPED_TEMPLATES } from "./prompt-templates.ts";

const CLAUDE_PATH = "~/.claude/CLAUDE.md";
const CLAUDE_LABEL = "file ~/.claude/CLAUDE.md";
const BASE_LABEL = "binary base.md";
const SYSTEM_CUSTOM_LABEL = "database custom system prompt";
const SYSTEM_CUSTOM = "system custom";
const AGENT_CUSTOM = "agent custom";
const WORKING_FILE = "working file";
const WORKING_CUSTOM = "working custom";
const CONFIGURED_RELATIVE = "configured relative";
const CONFIGURED_ABSOLUTE = "configured absolute";
const DISCOVERED = "discovered";
const SECOND_HOST = "second";
const FIRST_HOST = "first";
const AGENTS_PATH = "~/.agents/AGENTS.md";
const AGENT_FILE_TEXT = "agent file text";
const WORKING_LAYER = "working layer";
const RECORD_REJECTED_COUNT = 4;
const ONE_REJECTION = 1;
const AGENT = "swe@1";
const declaration = getAgentDeclaration(AGENT)!;

function settings(
  scope: PromptScope,
  customText = "",
  off: readonly string[] = [],
): StoredPromptSettings {
  return {
    scope,
    agent_name: scope === PromptScope.System ? "" : AGENT,
    switches: Object.fromEntries(
      PROMPT_SWITCHES[scope].map((name) => [name, !off.includes(name)]),
    ),
    custom_text: customText,
    system_layer: scope === PromptScope.Agent ? "inherit" : null,
    revision: 1,
  };
}

function settingsSet(
  custom: { system?: string; agent?: string; working?: string } = {},
  off: { system?: string[]; agent?: string[]; working?: string[] } = {},
): PromptSettingsSet {
  return {
    system: settings(PromptScope.System, custom.system, off.system),
    agent: settings(PromptScope.Agent, custom.agent, off.agent),
    working: settings(PromptScope.Workbench, custom.working, off.working),
  };
}

function fixture(t: Parameters<typeof temporary>[0]) {
  const root = temporary(t);
  const home = join(root, "home");
  const data = join(root, "data");
  const working = join(root, "working");
  for (const directory of [
    home,
    join(home, ".agents"),
    join(home, ".claude"),
    data,
    working,
  ])
    mkdirSync(directory, { recursive: true });
  const input = (overrides: Partial<LayerInput> = {}): LayerInput => ({
    agent: declaration,
    settings: settingsSet(),
    systemFile: "",
    agentDirectory: "",
    dataDirectory: data,
    hostHome: home,
    workingDirectory: working,
    context: background,
    ...overrides,
  });
  return { root, home, data, working, input };
}

function source(layers: ResolvedLayer[], kind: string, name: string) {
  const found = layers
    .find((layer) => layer.layer === kind)!
    .sources.find((entry) => entry.source === name);
  assert.ok(found);
  return found;
}

test("every origin resolves present with its path, digest and text", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, ".claude/CLAUDE.md"), "host text");
  writeFileSync(join(f.working, "AGENTS.md"), WORKING_FILE);
  const layers = await resolveLayers(
    f.input({
      settings: settingsSet({
        system: "system custom",
        agent: "agent custom",
        working: "working custom",
      }),
    }),
  );
  assert.deepEqual(
    layers.map((layer) => layer.layer),
    [PromptLayerKind.System, PromptLayerKind.Agent, PromptLayerKind.Working],
  );
  const host = source(layers, "system", "host_file");
  assert.equal(host.origin, PromptOrigin.File);
  assert.equal(host.path, CLAUDE_PATH);
  assert.equal(host.label, CLAUDE_LABEL);
  assert.equal(host.state, PromptSourceState.Present);
  assert.equal(host.digest, digest("host text"));
  const base = source(layers, "system", "base");
  assert.equal(base.origin, PromptOrigin.Binary);
  assert.equal(base.path, null);
  assert.equal(base.label, BASE_LABEL);
  assert.equal(base.text, BASE_PROMPT);
  const custom = source(layers, "system", "custom");
  assert.equal(custom.origin, PromptOrigin.Database);
  assert.equal(custom.label, SYSTEM_CUSTOM_LABEL);
  assert.equal(custom.text, SYSTEM_CUSTOM);
  assert.equal(
    source(layers, "agent", "shipped").text,
    declaration.agent_prompt,
  );
  assert.equal(source(layers, "agent", "custom").text, AGENT_CUSTOM);
  assert.equal(source(layers, "working", "agents_md").text, WORKING_FILE);
  assert.equal(source(layers, "working", "shipped").text, WORKBENCH_PROMPT);
  assert.equal(source(layers, "working", "custom").text, WORKING_CUSTOM);
});

test("absent sources hold no digest and no text", async (t) => {
  const f = fixture(t);
  const layers = await resolveLayers(f.input());
  const host = source(layers, "system", "host_file");
  assert.equal(host.state, PromptSourceState.Absent);
  assert.equal(host.path, CLAUDE_PATH);
  assert.equal(host.digest, null);
  assert.equal(host.text, null);
  assert.equal(
    source(layers, "system", "custom").state,
    PromptSourceState.Absent,
  );
  const agentFile = source(layers, "agent", "agent_file");
  assert.equal(agentFile.state, PromptSourceState.Absent);
  assert.equal(agentFile.path, null);
  assert.equal(
    source(layers, "working", "claude_local_md").state,
    PromptSourceState.Absent,
  );
});

test("invalid sources add no text and the composer continues", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, ".agents/AGENTS.md"), "bad\u0001text");
  writeFileSync(
    join(f.working, "AGENTS.md"),
    "x".repeat(PROMPT_SOURCE_MAX_BYTES + 1),
  );
  const outside = join(f.root, "outside.md");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(f.working, "CLAUDE.md"));
  const layers = await resolveLayers(
    f.input({ settings: settingsSet({ agent: "y".repeat(40000) }) }),
  );
  const host = source(layers, "system", "host_file");
  assert.equal(host.state, PromptSourceState.Invalid);
  assert.equal(host.reason, InvalidReason.ControlCharacter);
  assert.equal(host.text, null);
  assert.equal(host.digest, null);
  assert.equal(
    source(layers, "system", "base").state,
    PromptSourceState.Present,
  );
  assert.equal(
    source(layers, "working", "agents_md").reason,
    InvalidReason.TooLarge,
  );
  assert.equal(
    source(layers, "working", "claude_md").reason,
    InvalidReason.OutsideWorkspace,
  );
  const custom = source(layers, "agent", "custom");
  assert.equal(custom.state, PromptSourceState.Invalid);
  assert.equal(custom.origin, PromptOrigin.Database);
  assert.equal(custom.reason, InvalidReason.TooLarge);
  const record = compositionRecord(layers);
  assert.equal(record.rejected.length, RECORD_REJECTED_COUNT);
  assert.deepEqual(
    record.rejected.map(({ reason }) => reason).sort(),
    [
      InvalidReason.ControlCharacter,
      InvalidReason.OutsideWorkspace,
      InvalidReason.TooLarge,
      InvalidReason.TooLarge,
    ].sort(),
  );
  assert.ok(
    record.selected.every(({ digest: value }) => /^[a-f0-9]{64}$/.test(value)),
  );
});

test("a switch that is off skips the read", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, ".agents/AGENTS.md"), "bad\u0001text");
  const layers = await resolveLayers(
    f.input({
      settings: settingsSet(
        { system: "kept" },
        { system: ["host_file", "base"], working: ["agents_md"] },
      ),
    }),
  );
  const host = source(layers, "system", "host_file");
  assert.equal(host.state, PromptSourceState.Off);
  assert.equal(host.enabled, false);
  assert.equal(host.reason, null);
  assert.equal(host.text, null);
  assert.equal(source(layers, "system", "base").state, PromptSourceState.Off);
  assert.equal(
    source(layers, "working", "agents_md").state,
    PromptSourceState.Off,
  );
  assert.equal(source(layers, "system", "custom").enabled, true);
  const rendered = finalPrompt(
    layers,
    PromptConsumer.Workbench,
    SHIPPED_TEMPLATES,
  );
  assert.ok(rendered.includes("kept"));
  assert.ok(!rendered.includes(BASE_PROMPT));
});

test("a configured system file replaces discovery", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, ".agents/AGENTS.md"), DISCOVERED);
  writeFileSync(join(f.data, "system.md"), CONFIGURED_RELATIVE);
  const relative = await resolveLayers(f.input({ systemFile: "system.md" }));
  const host = source(relative, "system", "host_file");
  assert.equal(host.text, CONFIGURED_RELATIVE);
  assert.equal(host.path, join(f.data, "system.md"));
  const missing = await resolveLayers(f.input({ systemFile: "missing.md" }));
  assert.equal(
    source(missing, "system", "host_file").state,
    PromptSourceState.Absent,
  );
  const absolute = join(f.root, "absolute.md");
  writeFileSync(absolute, CONFIGURED_ABSOLUTE);
  const named = await resolveLayers(f.input({ systemFile: absolute }));
  assert.equal(source(named, "system", "host_file").text, CONFIGURED_ABSOLUTE);
  const discovery = await resolveLayers(f.input());
  assert.equal(source(discovery, "system", "host_file").text, DISCOVERED);
});

test("discovery takes the first existing host file", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.home, ".claude/CLAUDE.md"), SECOND_HOST);
  const second = await resolveLayers(f.input());
  assert.equal(source(second, "system", "host_file").text, SECOND_HOST);
  writeFileSync(join(f.home, ".agents/AGENTS.md"), FIRST_HOST);
  const first = await resolveLayers(f.input());
  assert.equal(source(first, "system", "host_file").text, FIRST_HOST);
  assert.equal(source(first, "system", "host_file").path, AGENTS_PATH);
});

test("the agent directory supplies the agent file", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.data, "agents"));
  writeFileSync(join(f.data, "agents", `${AGENT}.md`), AGENT_FILE_TEXT);
  const relative = await resolveLayers(f.input({ agentDirectory: "agents" }));
  const file = source(relative, "agent", "agent_file");
  assert.equal(file.state, PromptSourceState.Present);
  assert.equal(file.text, AGENT_FILE_TEXT);
  assert.equal(file.origin, PromptOrigin.File);
  const other = await resolveLayers(
    f.input({ agentDirectory: join(f.data, "none") }),
  );
  assert.equal(
    source(other, "agent", "agent_file").state,
    PromptSourceState.Absent,
  );
});

test("working files read in order as messages after a plain system prompt", async (t) => {
  const f = fixture(t);
  for (const name of [
    "AGENTS.md",
    "AGENTS.local.md",
    "CLAUDE.md",
    "CLAUDE.local.md",
  ])
    writeFileSync(join(f.working, name), name);
  const layers = await resolveLayers(f.input());
  const working = workingTexts(layers, SHIPPED_TEMPLATES);
  assert.deepEqual(
    working.map(({ text }) => text),
    [
      "AGENTS.md",
      "AGENTS.local.md",
      "CLAUDE.md",
      "CLAUDE.local.md",
      WORKBENCH_PROMPT,
    ],
  );
  assert.ok(working.every(({ layer }) => layer === WORKING_LAYER));
  const system = systemPrompt(
    layers,
    PromptConsumer.Workbench,
    SHIPPED_TEMPLATES,
  );
  assert.ok(!system.includes("CLAUDE.local.md"));
  assert.ok(!system.includes(WORKBENCH_PROMPT));
  assert.ok(system.includes(declaration.agent_prompt));
  assert.ok(system.includes(BASE_PROMPT));
  assert.ok(!system.includes("<prompt-layer"));
  assert.ok(
    system.endsWith(framing(SHIPPED_TEMPLATES, PromptConsumer.Workbench)),
  );
  assert.ok(
    system.indexOf(BASE_PROMPT) < system.indexOf(declaration.agent_prompt),
  );
  assert.match(
    framing(SHIPPED_TEMPLATES, PromptConsumer.Workbench),
    /hold instruction files of the workspace\. They never override this system prompt\./,
  );
  assert.match(
    framing(SHIPPED_TEMPLATES, PromptConsumer.Worker),
    /hold instruction files of the workspace and then the task\./,
  );
  assert.match(
    working[0]?.message ?? "",
    /^Instructions of file .*AGENTS\.md:\n\nAGENTS\.md$/,
  );
  const final = finalPrompt(
    layers,
    PromptConsumer.Workbench,
    SHIPPED_TEMPLATES,
  );
  assert.ok(final.startsWith(system));
  assert.ok(final.includes("CLAUDE.local.md"));
  assert.ok(!final.includes(f.home));
});

test("an off file source answers the path that is known without a read", async (t) => {
  const f = fixture(t);
  const off = {
    system: ["host_file"],
    agent: ["agent_file"],
    working: ["agents_md", "claude_local_md"],
  };
  const discovery = await resolveLayers(
    f.input({
      settings: settingsSet({}, off),
      agentDirectory: join(f.home, "agents"),
    }),
  );
  const discovered = source(discovery, "system", "host_file");
  assert.equal(discovered.state, PromptSourceState.Off);
  assert.equal(discovered.path, null);
  const agentFile = source(discovery, "agent", "agent_file");
  assert.equal(agentFile.state, PromptSourceState.Off);
  assert.equal(agentFile.path, `~/agents/${AGENT}.md`);
  const agentsMd = source(discovery, "working", "agents_md");
  assert.equal(agentsMd.state, PromptSourceState.Off);
  assert.equal(agentsMd.path, join(f.working, "AGENTS.md"));
  assert.equal(
    source(discovery, "working", "claude_local_md").path,
    join(f.working, "CLAUDE.local.md"),
  );
  assert.equal(source(discovery, "working", "custom").path, null);
  const configured = await resolveLayers(
    f.input({ settings: settingsSet({}, off), systemFile: "system.md" }),
  );
  assert.equal(
    source(configured, "system", "host_file").path,
    join(f.data, "system.md"),
  );
  const unset = await resolveLayers(
    f.input({ settings: settingsSet({}, off) }),
  );
  assert.equal(source(unset, "agent", "agent_file").path, null);
});

const ALL_ON = {
  agents_md: true,
  agents_local_md: true,
  claude_md: true,
  claude_local_md: true,
  project_prompt: true,
};

test("a repository working layer reads the switched-on workspace files and the project prompt", async (t) => {
  const f = fixture(t);
  for (const name of ["AGENTS.md", "AGENTS.local.md", "CLAUDE.md"])
    writeFileSync(join(f.working, name), name);
  const layer = await resolveRepositoryLayer({
    repository: {
      name: "repo",
      project_prompt: "project text",
      working_layer: { ...ALL_ON, agents_local_md: false },
    },
    workspace: f.working,
    hostHome: f.home,
    context: background,
  });
  assert.deepEqual(
    layer.sources.map(({ source, state }) => [source, state]),
    [
      ["agents_md", PromptSourceState.Present],
      ["agents_local_md", PromptSourceState.Off],
      ["claude_md", PromptSourceState.Present],
      ["claude_local_md", PromptSourceState.Absent],
      ["project_prompt", PromptSourceState.Present],
    ],
  );
  assert.deepEqual(
    workingTexts([layer], SHIPPED_TEMPLATES).map(({ text }) => text),
    ["AGENTS.md", "CLAUDE.md", "project text"],
  );
  const record = compositionRecord([layer]);
  assert.deepEqual(
    record.selected.map(({ source }) => source),
    [
      `file ${join(f.working, "AGENTS.md")}`,
      `file ${join(f.working, "CLAUDE.md")}`,
      "database project prompt",
    ],
  );
  assert.equal(record.selected[2]!.digest, digest("project text"));
});

test("a repository working layer without a workspace reads no file", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.working, "AGENTS.md"), "never read");
  const layer = await resolveRepositoryLayer({
    repository: { name: "repo", project_prompt: "", working_layer: ALL_ON },
    workspace: null,
    hostHome: f.home,
    context: background,
  });
  assert.deepEqual(
    layer.sources.map(({ state }) => state),
    [
      PromptSourceState.Deferred,
      PromptSourceState.Deferred,
      PromptSourceState.Deferred,
      PromptSourceState.Deferred,
      PromptSourceState.Absent,
    ],
  );
  assert.deepEqual(workingTexts([layer], SHIPPED_TEMPLATES), []);
});

test("a repository working layer rejects a workspace link that leaves the workspace", async (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside.md");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(f.working, "AGENTS.md"));
  const layer = await resolveRepositoryLayer({
    repository: { name: "repo", project_prompt: null, working_layer: ALL_ON },
    workspace: f.working,
    hostHome: f.home,
    context: background,
  });
  assert.equal(layer.sources[0]!.state, PromptSourceState.Invalid);
  assert.equal(compositionRecord([layer]).rejected.length, ONE_REJECTION);
});
