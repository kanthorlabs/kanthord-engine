import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import type { CredentialAnswer } from "../../custody/contract.ts";
import { writePrivate } from "../../kernel/files.ts";
import { temporary } from "../../kernel/test-support.ts";
import type { AgentEnablement } from "../../worker/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const SUCCESS = 0;
const FAILURE = 1;
const NO_OUTPUT = "";
const FIRST_REVISION = 1;
const SINGLE_ITEM = 1;
const SECOND_REVISION = 2;
const TWO_PROVIDERS = 2;
const THIRD_REVISION = 3;
const FOURTH_REVISION = 4;
const FIFTH_REVISION = 5;
const STALE = 99;
const AGENT = "swe@1";
const UNKNOWN_AGENT = "unknown-agent@1";
const OPENAI_AGENT = "re@1";
const ANTHROPIC = "anthropic";
const OPENAI = "openai-compatible";
const CREDENTIAL = "anthro-1";
const OPENAI_CREDENTIAL = "oai-1";
const DEFAULT = "default";
const BACKUP = "backup";
const SONNET = "claude-sonnet-4-5";
const GPT = "gpt-4o";
const TURBO = "gpt-4-turbo";
const OFF = "off";
const ENABLED = "enabled";
const DISABLED = "disabled";
const BASE_URL = "https://api.openai.com/v1";
const LOCAL_ENDPOINT = "http://127.0.0.1:1";
const COMMAND = ["worker", "agent", "enablement"];
const REVISION = "--expected-revision";
const SECRET = { key: "e2e-enablement-secret" };

type Result = Awaited<ReturnType<typeof kanthord>>;
type Answer = AgentEnablement & { idempotencyKey: string };
type CredentialResult = CredentialAnswer & { idempotencyKey: string };
type Fixture = { directory: string; env: NodeJS.ProcessEnv };

async function setup(t: TestContext): Promise<Fixture> {
  const fixture = await gatewayFixture(t);
  const directory = temporary(t);
  const env = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  assert.ok(env.KANTHORD_ENDPOINT);
  assert.ok(env.KANTHORD_TOKEN);
  return { directory, env };
}

function file(directory: string, name: string, value: unknown): string {
  assert.ok(directory.startsWith("/"));
  assert.ok(name.endsWith(".json"));
  const path = join(directory, name);
  writePrivate(path, JSON.stringify(value));
  return path;
}

function success<T = Answer>(result: Result): T {
  assert.equal(result.code, SUCCESS, result.stderr);
  assert.equal(result.stderr, NO_OUTPUT);
  return JSON.parse(result.stdout) as T;
}

function refusal(result: Result, code: string): void {
  assert.equal(result.code, FAILURE, result.stderr);
  assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
  assert.equal(result.stdout, NO_OUTPUT);
}

function enablementFile(fixture: Fixture, expectedRevision?: number): string {
  const path = file(
    fixture.directory,
    expectedRevision === undefined
      ? "enablement.json"
      : "stale-enablement.json",
    {
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      agentProviders: [
        { name: DEFAULT, provider: ANTHROPIC, credential: CREDENTIAL },
      ],
      defaultConfiguration: {
        agentProvider: DEFAULT,
        modelIdentifier: SONNET,
        reasoningEffort: OFF,
      },
    },
  );
  assert.ok(path.endsWith("enablement.json"));
  assert.ok(fixture.env.KANTHORD_TOKEN);
  return path;
}

async function createCredential(fixture: Fixture): Promise<void> {
  const credential = file(fixture.directory, "anthropic-cred.json", {
    name: CREDENTIAL,
    platform: ANTHROPIC,
    metadata: null,
    secret: SECRET,
  });
  const answer = success<CredentialResult>(
    await kanthord(
      ["llm", "credential", "create", "--file", credential],
      fixture.env,
    ),
  );
  assert.equal(answer.name, CREDENTIAL);
  assert.equal(answer.platform, ANTHROPIC);
}

async function created(fixture: Fixture): Promise<string> {
  await createCredential(fixture);
  const path = enablementFile(fixture);
  const put = success(
    await kanthord([...COMMAND, "put", AGENT, "--file", path], fixture.env),
  );
  assert.equal(put.revision, FIRST_REVISION);
  assert.equal(put.state, ENABLED);
  return path;
}

async function disabled(fixture: Fixture): Promise<void> {
  await created(fixture);
  const answer = success(
    await kanthord(
      [...COMMAND, "disable", AGENT, REVISION, String(FIRST_REVISION)],
      fixture.env,
    ),
  );
  assert.equal(answer.state, DISABLED);
  assert.equal(answer.revision, SECOND_REVISION);
}

async function enabled(fixture: Fixture): Promise<void> {
  await disabled(fixture);
  const answer = success(
    await kanthord(
      [...COMMAND, "enable", AGENT, REVISION, String(SECOND_REVISION)],
      fixture.env,
    ),
  );
  assert.equal(answer.state, ENABLED);
  assert.equal(answer.revision, THIRD_REVISION);
}

async function added(fixture: Fixture): Promise<void> {
  await enabled(fixture);
  const path = file(fixture.directory, "provider-add.json", {
    expectedRevision: THIRD_REVISION,
    name: BACKUP,
    provider: ANTHROPIC,
    credential: CREDENTIAL,
  });
  const answer = success(
    await kanthord(
      [...COMMAND, "provider", "add", AGENT, "--file", path],
      fixture.env,
    ),
  );
  assert.equal(answer.revision, FOURTH_REVISION);
  assert.equal(answer.agentProviders.length, TWO_PROVIDERS);
}

async function providerRemoved(fixture: Fixture): Promise<void> {
  await added(fixture);
  const answer = success(
    await kanthord(
      [
        ...COMMAND,
        "provider",
        "remove",
        AGENT,
        BACKUP,
        REVISION,
        String(FOURTH_REVISION),
      ],
      fixture.env,
    ),
  );
  assert.equal(answer.revision, FIFTH_REVISION);
  assert.equal(answer.agentProviders.length, SINGLE_ITEM);
}

async function removed(fixture: Fixture): Promise<void> {
  await providerRemoved(fixture);
  const answer = success<{ agentName: string }>(
    await kanthord(
      [...COMMAND, "remove", AGENT, REVISION, String(FIFTH_REVISION)],
      fixture.env,
    ),
  );
  assert.equal(answer.agentName, AGENT);
  assert.ok(answer.agentName);
}

test("E03.1 create credential and put enablement", async (t) => {
  const fixture = await setup(t);
  await created(fixture);
  const answer = success<AgentEnablement>(
    await kanthord([...COMMAND, "get", AGENT], fixture.env),
  );
  assert.equal(answer.agentName, AGENT);
  assert.equal(answer.state, ENABLED);
  assert.equal(answer.revision, FIRST_REVISION);
});

test("E03.2 list enablements", async (t) => {
  const fixture = await setup(t);
  await created(fixture);
  const answer = success<{
    items: AgentEnablement[];
    nextCursor: string | null;
  }>(await kanthord([...COMMAND, "list"], fixture.env));
  assert.equal(answer.items.length, SINGLE_ITEM);
  assert.equal(answer.items[0]?.agentName, AGENT);
  assert.equal(answer.nextCursor, null);
});

test("E03.3 get enablement", async (t) => {
  const fixture = await setup(t);
  await created(fixture);
  const answer = success<AgentEnablement>(
    await kanthord([...COMMAND, "get", AGENT], fixture.env),
  );
  assert.equal(answer.agentName, AGENT);
  assert.equal(answer.revision, FIRST_REVISION);
  assert.equal(answer.state, ENABLED);
});

test("E03.4 stale put refuses revision", async (t) => {
  const fixture = await setup(t);
  await created(fixture);
  const path = enablementFile(fixture, STALE);
  refusal(
    await kanthord([...COMMAND, "put", AGENT, "--file", path], fixture.env),
    "worker.agent.enablement.revision_conflict",
  );
});

test("E03.5 disable enablement", async (t) => {
  const fixture = await setup(t);
  await disabled(fixture);
  const answer = success<AgentEnablement>(
    await kanthord([...COMMAND, "get", AGENT], fixture.env),
  );
  assert.equal(answer.state, DISABLED);
  assert.equal(answer.revision, SECOND_REVISION);
});

test("E03.6 enable again", async (t) => {
  const fixture = await setup(t);
  await enabled(fixture);
  const answer = success<AgentEnablement>(
    await kanthord([...COMMAND, "get", AGENT], fixture.env),
  );
  assert.equal(answer.state, ENABLED);
  assert.equal(answer.revision, THIRD_REVISION);
});

test("E03.7 add backup provider", async (t) => {
  const fixture = await setup(t);
  await added(fixture);
  const answer = success<AgentEnablement>(
    await kanthord([...COMMAND, "get", AGENT], fixture.env),
  );
  assert.equal(answer.revision, FOURTH_REVISION);
  assert.equal(answer.agentProviders.length, TWO_PROVIDERS);
});

test("E03.8 remove backup provider", async (t) => {
  const fixture = await setup(t);
  await providerRemoved(fixture);
  const answer = success<AgentEnablement>(
    await kanthord([...COMMAND, "get", AGENT], fixture.env),
  );
  assert.equal(answer.revision, FIFTH_REVISION);
  assert.equal(answer.agentProviders.length, SINGLE_ITEM);
});

test("E03.9 remove enablement", async (t) => {
  const fixture = await setup(t);
  await removed(fixture);
});

test("E03.10 removed enablement is not found", async (t) => {
  const fixture = await setup(t);
  await removed(fixture);
  refusal(
    await kanthord([...COMMAND, "get", AGENT], fixture.env),
    "worker.agent.enablement.not_found",
  );
});

test("E03.11 metadata removal preserves referenced model atomically", async (t) => {
  const fixture = await setup(t);
  const { directory, env } = fixture;
  const credential = file(directory, "openai-cred.json", {
    name: OPENAI_CREDENTIAL,
    platform: OPENAI,
    metadata: { baseUrl: BASE_URL, models: [] },
    secret: SECRET,
  });
  const createdCredential = success<CredentialResult>(
    await kanthord(["llm", "credential", "create", "--file", credential], env),
  );
  assert.ok(createdCredential.revisions[0]);
  const metadata = (name: string, expectedRevision: number, models: string[]) =>
    file(directory, name, {
      expectedRevision,
      metadata: { baseUrl: BASE_URL, models: models.map((id) => ({ id })) },
    });
  const twoModels = metadata(
    "meta-two-models.json",
    createdCredential.revisions[0].revision,
    [GPT, TURBO],
  );
  const updated = success<CredentialResult>(
    await kanthord(
      [
        "llm",
        "credential",
        "update-metadata",
        OPENAI_CREDENTIAL,
        "--file",
        twoModels,
      ],
      env,
    ),
  );
  assert.ok(updated.revisions[0]);
  const putFile = file(directory, "enablement-oai.json", {
    agentProviders: [
      { name: DEFAULT, provider: OPENAI, credential: OPENAI_CREDENTIAL },
    ],
    defaultConfiguration: {
      agentProvider: DEFAULT,
      modelIdentifier: GPT,
      reasoningEffort: OFF,
    },
  });
  const put = success(
    await kanthord([...COMMAND, "put", OPENAI_AGENT, "--file", putFile], env),
  );
  assert.equal(put.defaultConfiguration.modelIdentifier, GPT);
  const dropTurbo = metadata(
    "meta-drop-turbo.json",
    updated.revisions[0].revision,
    [GPT],
  );
  const retained = success<CredentialResult>(
    await kanthord(
      [
        "llm",
        "credential",
        "update-metadata",
        OPENAI_CREDENTIAL,
        "--file",
        dropTurbo,
      ],
      env,
    ),
  );
  assert.ok(retained.revisions[0]);
  const dropGpt = metadata(
    "meta-drop-gpt4o.json",
    retained.revisions[0].revision,
    [],
  );
  refusal(
    await kanthord(
      [
        "llm",
        "credential",
        "update-metadata",
        OPENAI_CREDENTIAL,
        "--file",
        dropGpt,
      ],
      env,
    ),
    "llm.metadata.model_in_use",
  );
  const read = success<CredentialAnswer>(
    await kanthord(["llm", "credential", "get", OPENAI_CREDENTIAL], env),
  );
  assert.equal(read.revisions[0]?.revision, retained.revisions[0].revision);
  const models = read.revisions[0]?.metadata?.models;
  assert.ok(Array.isArray(models));
  assert.ok(models.some((model: { id: string }) => model.id === GPT));
  assert.ok(!models.some((model: { id: string }) => model.id === TURBO));
  const enablement = success<AgentEnablement>(
    await kanthord([...COMMAND, "get", OPENAI_AGENT], env),
  );
  assert.equal(enablement.defaultConfiguration.modelIdentifier, GPT);
});

test("E03.12 put replays same idempotency key", async (t) => {
  const fixture = await setup(t);
  await createCredential(fixture);
  const path = enablementFile(fixture);
  const key = ulid();
  const args = [
    ...COMMAND,
    "put",
    AGENT,
    "--file",
    path,
    "--idempotency-key",
    key,
  ];
  const first = success(await kanthord(args, fixture.env));
  const second = success(await kanthord(args, fixture.env));
  assert.equal(first.revision, second.revision);
  assert.equal(first.idempotencyKey, key);
  assert.equal(second.idempotencyKey, key);
  assert.deepEqual(second, first);
});

test("E03.13 invalid enable revision refuses locally", async (t) => {
  const fixture = await setup(t);
  refusal(
    await kanthord(
      [
        ...COMMAND,
        "enable",
        AGENT,
        "--endpoint",
        LOCAL_ENDPOINT,
        "--token",
        "t",
        REVISION,
        "abc",
      ],
      fixture.env,
    ),
    "cli.worker.agent.enablement.enable.invalid_revision",
  );
});

test("E03.14 put without token refuses locally", async (t) => {
  const fixture = await setup(t);
  const env = { ...fixture.env, KANTHORD_TOKEN: undefined };
  refusal(
    await kanthord(
      [
        ...COMMAND,
        "put",
        AGENT,
        "--endpoint",
        LOCAL_ENDPOINT,
        "--file",
        "enablement.json",
      ],
      env,
    ),
    "cli.worker.agent.enablement.put.token_required",
  );
});

test("E03.15 unknown agent refuses put", async (t) => {
  const fixture = await setup(t);
  const path = await created(fixture);
  refusal(
    await kanthord(
      [...COMMAND, "put", UNKNOWN_AGENT, "--file", path],
      fixture.env,
    ),
    "worker.agent.not_found",
  );
});

test("E03.16 last provider cannot be removed", async (t) => {
  const fixture = await setup(t);
  await created(fixture);
  refusal(
    await kanthord(
      [
        ...COMMAND,
        "provider",
        "remove",
        AGENT,
        DEFAULT,
        REVISION,
        String(FIRST_REVISION),
      ],
      fixture.env,
    ),
    "worker.agent.enablement.provider.required",
  );
});
