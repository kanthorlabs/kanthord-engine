import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import * as connector from "../repository/connector.ts";
import {
  anthropicAgent,
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
  unusedHostTools,
  WORKING_LAYER_ALL_ON,
} from "./test-support.ts";
import { runNativeExecution } from "./native-method.ts";
import { WorkspaceRoot } from "./workspace.ts";
import { noTranscript } from "./transcript.ts";
import type { MethodClients } from "./method-clients.ts";
import type { ModelRuntimeFactory } from "./model-runtime.ts";
import { REVIEW_MARKER } from "./review.ts";

const JUDGEMENT =
  'kanthord-judgement: {"criterion_met": true, "rationale": "met"}';
const REVIEWER_CALLS = 1;
const REVIEW_AGENT = "re@1";

test("developer@1 opens the reviewer from the second agent with its own credential and closes it", async (t) => {
  const state = temporary(t);
  const origin = temporary(t);
  const git = simpleGit(origin);
  await git.init();
  await git.raw(["checkout", "-b", "main"]);
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  writeFileSync(join(origin, "file"), "base");
  await git.add("file");
  await git.commit("base");
  const bare = join(state, "origin.git");
  await git.clone(origin, bare, ["--bare"]);
  const reviewerCredential = createIdentity("credential");
  const setup = anthropicSetup({
    worker_name: "developer@1",
    agents: [
      anthropicAgent(),
      anthropicAgent({
        agent_name: REVIEW_AGENT,
        credential_id: reviewerCredential,
      }),
    ],
    repositories: [
      {
        binding_id: createIdentity("binding"),
        name: "repo",
        address: bare,
        ssh_identity: {
          host: "github.com",
          hostname: "github.com",
          port: 22,
          identity_file: "~/.ssh/id_test",
        },
        strategy: { base_branch: "main" },
        project_prompt: null,
        working_layer: WORKING_LAYER_ALL_ON,
      },
    ],
  });
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
  };
  const content = (name: string) => ({
    name,
    requirement: name,
    criterion: name,
    verifications: ["test -f a.txt"],
    bindings: [],
  });
  const complete = (data: unknown) => ({
    type: "completed",
    status: 200,
    data,
  });
  const clients = {
    mission: {
      "execution.pinnedRevision.get": async () =>
        complete({
          content: content("objective"),
          tasks: [
            {
              id: createIdentity("node"),
              filename: "task.md",
              content: content("task"),
            },
          ],
        }),
      "execution.reworkAssessment.get": async () => ({
        type: "failure",
        status: 404,
        error: {
          request_id: "request",
          error: {
            code: "mission.record.not_found",
            message: "Not found",
            details: null,
          },
        },
      }),
      "evidence.submit": async () => complete({ evidence: {} }),
    },
    scheduler: { executionRelease: async () => complete({}) },
  } as unknown as MethodClients;
  const store = async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("anthropic", async () => ({
      type: "api_key",
      key: "test_developer_key",
    }));
    return credentials;
  };
  const worker = scriptedProvider([
    fauxAssistantMessage(
      fauxToolCall("write", { path: "a.txt", content: "a" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
    fauxAssistantMessage(JUDGEMENT),
  ]);
  const reviewer = scriptedProvider([
    fauxAssistantMessage(`${REVIEW_MARKER} {"findings": []}`),
  ]);
  const opened: { agent: string; credential: string }[] = [];
  const factory: ModelRuntimeFactory = (input) => {
    opened.push({
      agent: input.agent.agent_name,
      credential: input.credential.credential_id,
    });
    return scriptedModelRuntime(
      input.agent.agent_name === REVIEW_AGENT ? reviewer : worker,
    )(input);
  };
  const workspaces = WorkspaceRoot.open(state);
  const result = await runNativeExecution({
    claim,
    setup,
    clients,
    credentials: {
      items: [
        {
          credential_id: setup.agents[0]!.credential_id,
          provider_id: "anthropic",
          store: await store(),
        },
        {
          credential_id: reviewerCredential,
          provider_id: "anthropic",
          store: await store(),
        },
      ],
      release: async () => {},
    },
    transport: { ...connector, proveSshIdentity: async () => {} },
    workspaces,
    hostHome: temporary(t),
    modelRuntimeFactory: factory,
    transcript: noTranscript,
    hostTools: () => unusedHostTools,
    context: background,
  });
  assert.deepEqual(result, { kind: "released", furtherWork: false });
  assert.deepEqual(opened, [
    { agent: "swe@1", credential: setup.agents[0]!.credential_id },
    { agent: REVIEW_AGENT, credential: reviewerCredential },
  ]);
  assert.equal(reviewer.calls.length, REVIEWER_CALLS);
});
