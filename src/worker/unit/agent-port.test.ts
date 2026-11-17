import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  InlineExtension,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  agentPort,
  type SessionBudget,
  type SessionOpenRequest,
} from "../../agent/agent-port.ts";
import { executionEvidence } from "../../agent/capabilities/execution-evidence.ts";
import { linkUpdates } from "../../agent/capabilities/link-updates.ts";
import { AGENT_DECLARATIONS } from "../../agent/catalog.ts";
import { piAgentDirectory } from "../../agent/pi.ts";
import { SESSION_MARKER_PATTERN } from "../../agent/sensitive-text.ts";
import { background, CancellationContext } from "../../kernel/context.ts";
import {
  hostEnvironment,
  overrideEnvironment,
  stopAfter,
  temporary,
} from "../../kernel/test-support.ts";
import type { HostTools } from "../contract.ts";
import { ExecutionBudget } from "./budget.ts";
import {
  anthropicAgent,
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
  unusedHostTools,
} from "./test-support.ts";

const SECRET = "test_agent_port_secret_value";
const OUTSIDE_TEXT = "text-outside-the-review-roots";
const HOME_TEXT = "text-in-the-home-directory";
const CHECKOUT_TEXT = "text-inside-the-review-checkout";
const EVIDENCE_TEXT = "text-inside-the-evidence-directory";
const REFUSAL = "is outside the checkout";
const TOOL_RESULT = "toolResult";
const CLEANUP_MS = 200;
const ONE_CALL = 1;
const CLOSE_LIMIT_MS = 5000;
const FORBIDDEN_FILES = ["auth.json", "settings.json", "mcp-auth.json"];

type Script = Parameters<typeof scriptedProvider>[0];

interface PortOptions {
  agentName?: string;
  capabilities?: readonly InlineExtension[];
  hostTools?: HostTools;
  budget?: SessionBudget;
  reviewWorkspace?: SessionOpenRequest["reviewWorkspace"];
}

const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function opened(t: TestContext, script: Script, options: PortOptions) {
  const setup = anthropicSetup({
    agents: [anthropicAgent({ agent_name: options.agentName ?? "swe@1" })],
  });
  const workspace = realpathSync(temporary(t));
  const hostHome = realpathSync(temporary(t));
  const sessionRoot = temporary(t);
  const provider = scriptedProvider(script);
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "api_key",
    key: SECRET,
  }));
  const tools = () => options.hostTools ?? unusedHostTools;
  const port = agentPort({
    capabilities: options.capabilities ?? [
      executionEvidence(tools),
      linkUpdates(tools),
    ],
    modelRuntimeFactory: ({ agent, signal }) =>
      scriptedModelRuntime(provider)({
        credential: {
          credential_id: agent.credential_id,
          provider_id: "anthropic",
          store,
        },
        agent,
        signal,
      }),
    knownSecrets: async () => [SECRET],
    trace: () => null,
    sessionRoot,
    budget:
      options.budget ??
      new ExecutionBudget({
        created_at: Date.now(),
        expired_at: Date.now() + 60000,
        resource_budget: setup.resource_budget,
      }),
    env: hostEnvironment(),
    hostHome,
  });
  const context = new CancellationContext(background);
  stopAfter(t, () => context.cancel());
  const session = await port.open(
    {
      claim: setup,
      setup,
      checkouts: [{ directory: workspace }],
      reviewWorkspace: options.reviewWorkspace ?? null,
    },
    context,
  );
  stopAfter(t, () => session.close());
  const results = () =>
    session.session.messages.filter(
      (message) => message.role === TOOL_RESULT,
    ) as unknown as { isError: boolean; content: unknown }[];
  return { session, provider, workspace, hostHome, sessionRoot, results };
}

function reviewLayout(t: TestContext) {
  const base = realpathSync(temporary(t));
  const key = join(base, "review");
  const checkout = join(key, "checkouts", "app");
  const evidence = join(key, "evidence");
  const outside = join(base, "outside.txt");
  const home = join(base, "home");
  for (const directory of [checkout, evidence, home])
    mkdirSync(directory, { recursive: true });
  writeFileSync(join(checkout, "inside.txt"), CHECKOUT_TEXT);
  writeFileSync(join(evidence, "report.txt"), EVIDENCE_TEXT);
  writeFileSync(outside, OUTSIDE_TEXT);
  writeFileSync(join(home, "secret.txt"), HOME_TEXT);
  symlinkSync(outside, join(checkout, "leak"));
  symlinkSync(base, join(checkout, "up"));
  overrideEnvironment(t, { HOME: home });
  return { base, key, checkout, evidence, outside };
}

test("path_refused: a re@1 session refuses a read of @absolute, ~, file:// and a symbolic link that leaves the review roots, and reads the checkout and the evidence directory", async (t) => {
  const layout = reviewLayout(t);
  const escapes = [
    tool("read", { path: `@${layout.outside}` }),
    tool("read", { path: "~/secret.txt" }),
    tool("ls", { path: "~" }),
    tool("read", { path: `file://${layout.outside}` }),
    tool("read", { path: "leak" }),
    tool("grep", { pattern: "text", path: "up" }),
    tool("find", { pattern: "*.txt", path: "../.." }),
    tool("read", { path: layout.outside }),
  ];
  const h = await opened(
    t,
    [
      ...escapes,
      tool("read", { path: "inside.txt" }),
      tool("read", { path: "../../evidence/report.txt" }),
      tool("read", { path: join(layout.evidence, "report.txt") }),
      tool("ls", {}),
      fauxAssistantMessage("done"),
    ],
    {
      agentName: "re@1",
      reviewWorkspace: { key: layout.key, directory: layout.checkout },
    },
  );
  await h.session.session.prompt("review");
  const results = h.results();
  assert.deepEqual(
    results.map((result) => result.isError),
    [...escapes.map(() => true), false, false, false, false],
  );
  for (const result of results.slice(0, escapes.length))
    assert.ok(JSON.stringify(result.content).includes(REFUSAL));
  const sent = JSON.stringify(h.provider.calls);
  assert.ok(!sent.includes(OUTSIDE_TEXT));
  assert.ok(!sent.includes(HOME_TEXT));
  assert.ok(sent.includes(CHECKOUT_TEXT));
  assert.ok(sent.includes(EVIDENCE_TEXT));
});

test("path_refused: a re@1 session over a workspace with no checkout has the workspace directory as its only root", async (t) => {
  const base = realpathSync(temporary(t));
  const directory = join(base, "execution");
  mkdirSync(directory);
  writeFileSync(join(directory, "asset.txt"), EVIDENCE_TEXT);
  mkdirSync(join(base, "evidence"));
  writeFileSync(join(base, "evidence", "report.txt"), OUTSIDE_TEXT);
  const h = await opened(
    t,
    [
      tool("read", { path: "asset.txt" }),
      tool("read", { path: "../evidence/report.txt" }),
      fauxAssistantMessage("done"),
    ],
    { agentName: "re@1", reviewWorkspace: { key: directory, directory } },
  );
  await h.session.session.prompt("review");
  assert.deepEqual(
    h.results().map((result) => result.isError),
    [false, true],
  );
  const sent = JSON.stringify(h.provider.calls);
  assert.ok(sent.includes(EVIDENCE_TEXT));
  assert.ok(!sent.includes(OUTSIDE_TEXT));
});

function rogueTool(name: string, ran: string[]): ToolDefinition {
  return {
    name,
    label: name,
    description: "A tool that no agent declaration names.",
    parameters: Type.Object({}),
    exposure: "deferred",
    annotations: { openWorldHint: true },
    async execute() {
      ran.push(name);
      return { content: [{ type: "text", text: "ran" }], details: null };
    },
  } as unknown as ToolDefinition;
}

test("the active tools equal the declared set, and an undeclared capability tool is not active and its direct and nested calls are blocked", async (t) => {
  const ran: string[] = [];
  const nested: unknown[] = [];
  let api: ExtensionAPI | undefined;
  const capability: InlineExtension = (pi) => {
    api = pi;
    pi.registerTool(rogueTool("rogue", ran));
    pi.registerTool(rogueTool("mcp__rogue__run", ran));
    pi.registerTool({
      name: "link_update_list",
      label: "link_update_list",
      description: "A declared tool that calls an undeclared tool.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _update, context) {
        nested.push(await context.executeTool("mcp__rogue__run", {}));
        return { content: [{ type: "text", text: "called" }], details: null };
      },
    });
  };
  const h = await opened(
    t,
    [
      tool("rogue", {}),
      tool("mcp__rogue__run", {}),
      tool("link_update_list", {}),
      fauxAssistantMessage("done"),
    ],
    { capabilities: [executionEvidence(() => unusedHostTools), capability] },
  );
  const declared = AGENT_DECLARATIONS["swe@1"];
  assert.ok(api);
  assert.deepEqual(
    api.getActiveTools().toSorted(),
    [...declared.tools, ...declared.host_tools].toSorted(),
  );
  await h.session.session.prompt("work");
  assert.deepEqual(ran, []);
  assert.deepEqual(
    h.results().map((result) => result.isError),
    [true, true, false],
  );
  assert.equal(nested.length, ONE_CALL);
  assert.ok(
    JSON.stringify(nested).includes(
      "The tool mcp__rogue__run is not declared for this agent.",
    ),
    JSON.stringify(nested),
  );
});

test("redaction: a capability tool outside the restore tools gets the marker and never the secret value", async (t) => {
  const value = ["AKIA", "KANTHORDCANARY01"].join("");
  const paths: string[] = [];
  const h = await opened(
    t,
    [
      (context) => {
        const [marker] =
          JSON.stringify(context.messages).match(SESSION_MARKER_PATTERN) ?? [];
        assert.ok(marker);
        return tool("evidence-upload", { path: marker });
      },
      fauxAssistantMessage("done"),
    ],
    {
      hostTools: {
        ...unusedHostTools,
        evidenceUpload: async (path) => {
          paths.push(path);
          return {
            evidence_id: "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAA",
            asset_id: "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA",
            uri: "s3://test-bucket/a.txt",
          };
        },
      },
    },
  );
  await h.session.session.prompt(`upload ${value}`);
  assert.equal(paths.length, ONE_CALL);
  assert.match(paths[0]!, new RegExp(SESSION_MARKER_PATTERN.source));
  assert.ok(!paths[0]!.includes(value));
  assert.ok(!JSON.stringify(h.provider.calls).includes(value));
});

function filesUnder(directory: string): string[] {
  return existsSync(directory)
    ? readdirSync(directory, { recursive: true }).map(String)
    : [];
}

test("a capability resource starts at the open and stops at the close, and the session writes no auth.json and no settings file", async (t) => {
  const events: string[] = [];
  const capability: InlineExtension = (pi) => {
    pi.on("session_start", () => void events.push("start"));
    pi.on("session_shutdown", () => void events.push("shutdown"));
  };
  const h = await opened(t, [fauxAssistantMessage("done")], {
    capabilities: [capability],
  });
  assert.deepEqual(events, ["start"]);
  await h.session.session.prompt("work");
  await h.session.close();
  await h.session.close();
  assert.deepEqual(events, ["start", "shutdown"]);
  const written = [
    ...filesUnder(h.hostHome),
    ...filesUnder(h.sessionRoot),
    ...filesUnder(h.workspace),
    ...filesUnder(piAgentDirectory()),
  ];
  assert.deepEqual(
    written.filter((name) =>
      FORBIDDEN_FILES.some((file) => name.endsWith(file)),
    ),
    [],
  );
  assert.ok(filesUnder(h.sessionRoot).some((name) => name.endsWith(".jsonl")));
});

test("the close ends at the cleanup deadline when a capability does not stop", async (t) => {
  const shutdown = Promise.withResolvers<void>();
  stopAfter(t, () => shutdown.resolve());
  let entered = false;
  const capability: InlineExtension = (pi) => {
    pi.on("session_shutdown", () => {
      entered = true;
      return shutdown.promise;
    });
  };
  const h = await opened(t, [fauxAssistantMessage("done")], {
    capabilities: [capability],
    budget: {
      agentContext: (parent) => new CancellationContext(parent),
      cleanupContext: (parent) =>
        new CancellationContext(parent, Date.now() + CLEANUP_MS),
      remainingMs: () => CLOSE_LIMIT_MS,
    },
  });
  const started = Date.now();
  await h.session.close();
  const elapsed = Date.now() - started;
  assert.equal(entered, true);
  assert.ok(elapsed >= CLEANUP_MS / 2, String(elapsed));
  assert.ok(elapsed < CLOSE_LIMIT_MS, String(elapsed));
});
