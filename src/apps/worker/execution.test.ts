import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { temporary, hostEnvironment } from "../../kernel/test-support.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  sealEnvelope,
} from "../../kernel/handover.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  EndReason,
  WorkspaceRoot,
  noTranscript,
  type NativeExecutionInput,
} from "../../worker/unit/index.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import type { ExecutionSetup } from "../../worker/contract.ts";
import { httpTransport } from "./transport.ts";
import { testClaim } from "./test-support.ts";
import { hostExecution } from "./execution.ts";
import { ChainLevel } from "../../agent/contract.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import { ExecutionIntent } from "../../worker/contract.ts";
import { WORKING_LAYER_ALL_ON } from "../../worker/test-support.ts";
import { generateSshKey } from "../../repository/ssh-key.ts";
import type { SshAccess } from "../../repository/contract.ts";
import { DEFAULT_SSH_PORT } from "../../repository/test-sshd.ts";

const SECRET = Buffer.alloc(32, 7).toString("base64");
const ENDED_RECORD = "execution ended";
const NO_ENTRIES = 0;
const ONE_ENTRY = 1;
const UNKNOWN_FAILURE = "system.operation.unknown";
const PROVIDER_CAUSE = "OAuth auth derivation failed for anthropic";
test("host logs the stop of a released or ended execution in the execution ended record", async (t) => {
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  const credential = {
    credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    provider_id: "anthropic",
    credential: { type: "api_key", key: "test_host_key" },
  };
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(
      deriveHandoverKeys(SECRET).handover,
      handoverAad(claim.execution_id, claim.claimant.runtime_identity),
      { items: [credential], ssh_identities: [] },
    ),
  }));
  t.mock.method(api.worker, "execution.setup.get", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: {
      execution_id: claim.execution_id,
      worker_name: "coder@1",
      agents: [],
      templates: SHIPPED_TEMPLATES,
      resource_budget: { turns: 200, wall_time_ms: 7200000 },
      intent: ExecutionIntent.Implement,
      repositories: [],
    },
  }));
  const records: Record<string, unknown>[] = [];
  const input = {
    api,
    claim,
    clientSecret: SECRET,
    context: background,
    workspaces: WorkspaceRoot.open(temporary(t)),
    transport: new RepositoryComponent(),
    modelRuntimeFactory: async () => {
      throw new Error("Unexpected inference");
    },
    hostHome: temporary(t),
    env: hostEnvironment(),
    transcript: noTranscript,
    log: (record: Record<string, unknown>) => records.push(record),
  };
  const stop = {
    reason: EndReason.OperationFailed,
    code: "repository.host_key.unpinned",
  };
  const providerStop = {
    reason: EndReason.ProviderFailed,
    code: "unavailable",
  };
  await hostExecution(input, async () => ({
    kind: "released",
    furtherWork: true,
    stop,
  }));
  await hostExecution(input, async () => ({
    kind: "released",
    furtherWork: false,
  }));
  await hostExecution(input, async () => ({ kind: "ended", ...stop }));
  await hostExecution(input, async () => ({
    kind: "released",
    furtherWork: true,
    stop: { ...providerStop, detail: PROVIDER_CAUSE },
  }));
  await hostExecution(input, async () => ({
    kind: "ended",
    ...providerStop,
    detail: PROVIDER_CAUSE,
  }));
  const ended = records.filter((record) => record.msg === ENDED_RECORD);
  assert.deepEqual(ended, [
    {
      msg: ENDED_RECORD,
      execution_id: claim.execution_id,
      kind: "released",
      reason: stop.reason,
      code: stop.code,
    },
    {
      msg: ENDED_RECORD,
      execution_id: claim.execution_id,
      kind: "released",
    },
    {
      msg: ENDED_RECORD,
      execution_id: claim.execution_id,
      kind: "ended",
      reason: stop.reason,
      code: stop.code,
    },
    {
      msg: ENDED_RECORD,
      execution_id: claim.execution_id,
      kind: "released",
      reason: providerStop.reason,
      code: providerStop.code,
      detail: PROVIDER_CAUSE,
    },
    {
      msg: ENDED_RECORD,
      execution_id: claim.execution_id,
      kind: "ended",
      reason: providerStop.reason,
      code: providerStop.code,
      detail: PROVIDER_CAUSE,
    },
  ]);
});
test("host takes handover before setup and method, discards on every method end", async (t) => {
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  const events: string[] = [];
  const credential = {
    credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    provider_id: "anthropic",
    credential: { type: "api_key", key: "test_host_key" },
  };
  const key = generateSshKey("deploy");
  const bindingId = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB";
  let held: ReadonlyMap<string, SshAccess> | undefined;
  const setup: ExecutionSetup = {
    execution_id: claim.execution_id,
    worker_name: "coder@1",
    agents: [
      {
        agent_name: "swe@1",
        credential_id: credential.credential_id,
        effective_configuration: {
          agent_provider: "default",
          provider: "anthropic",
          credential: "anthro-1",
          model_identifier: "claude-sonnet-4-5",
          reasoning_effort: "off",
        },
        position: 0,
        level: ChainLevel.Enablement,
        metadata: null,
        prompt: { final: "setup prompt" },
      },
    ],
    templates: SHIPPED_TEMPLATES,
    resource_budget: { turns: 200, wall_time_ms: 7200000 },
    intent: ExecutionIntent.Implement,
    repositories: [
      {
        binding_id: bindingId,
        name: "repo",
        address: "git@github.com:owner/repo.git",
        ssh_host_key: { known_hosts: KNOWN_HOSTS },
        strategy: { base_branch: "main" },
        project_prompt: null,
        working_layer: WORKING_LAYER_ALL_ON,
      },
    ],
  };
  t.mock.method(api.worker, "handover", async () => {
    events.push("handover");
    return {
      type: OperationResultType.Completed,
      status: 200,
      data: sealEnvelope(
        deriveHandoverKeys(SECRET).handover,
        handoverAad(claim.execution_id, claim.claimant.runtime_identity),
        {
          items: [credential],
          ssh_identities: [
            {
              binding_id: bindingId,
              credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAB",
              private_key: key.private_key,
            },
          ],
        },
      ),
    };
  });
  t.mock.method(api.worker, "execution.setup.get", async () => {
    events.push("setup");
    return { type: OperationResultType.Completed, status: 200, data: setup };
  });
  const input = {
    api,
    claim,
    clientSecret: SECRET,
    context: background,
    workspaces: WorkspaceRoot.open(temporary(t)),
    transport: new RepositoryComponent(),
    modelRuntimeFactory: async () => {
      throw new Error("Unexpected inference");
    },
    hostHome: temporary(t),
    env: hostEnvironment(),
    transcript: noTranscript,
    log: () => {},
  };
  let stored: NativeExecutionInput["credentials"] | undefined;
  assert.equal(
    await hostExecution(input, async (native) => {
      events.push("method");
      stored = native.credentials;
      assert.equal(native.transcript, noTranscript);
      assert.ok(native.hostTools(temporary(t)).evidenceUpload);
      return { kind: "released", furtherWork: false };
    }),
    null,
  );
  assert.deepEqual(events, ["handover", "setup", "method"]);
  const stop = {
    reason: EndReason.OperationFailed,
    code: "llm.provider.unavailable",
  };
  assert.equal(
    await hostExecution(input, async () => ({
      kind: "released",
      furtherWork: true,
      stop,
    })),
    null,
  );
  assert.equal(
    (await hostExecution(input, async () => ({ kind: "ended", ...stop })))
      ?.code,
    stop.code,
  );
  assert.equal(
    await hostExecution(input, async () => ({
      kind: "ended",
      reason: EndReason.Revoked,
      code: "scheduler.execution.not_running",
    })),
    null,
  );
  assert.equal(
    await stored!.items[0]!.store.read(credential.provider_id),
    undefined,
  );
  const expected = "system.operation.unknown";
  assert.equal(
    (
      await hostExecution(input, async (native) => {
        stored = native.credentials;
        held = native.sshAccess;
        assert.equal(held.size, ONE_ENTRY);
        throw new Error("test_private_material");
      })
    )?.code,
    expected,
  );
  assert.equal(held?.size, NO_ENTRIES);
  assert.equal(
    await stored!.items[0]!.store.read(credential.provider_id),
    undefined,
  );
  const workspace = temporary(t);
  await writeFile(join(workspace, "a.txt"), "test evidence");
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 200 }),
  );
  for (const operation of [
    "evidence.submit",
    "evidence.asset.complete",
  ] as const) {
    for (const [status, code] of [
      [403, "gateway.invocation.execution_proof_failed"],
      [409, "scheduler.execution.not_running"],
    ] as const) {
      const failure = {
        type: OperationResultType.Failure,
        status,
        error: {
          request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
          error: { code, message: "Ended", details: null },
        },
      };
      t.mock.method(api.mission, "evidence.submit", async () => ({
        type: OperationResultType.Completed,
        status: 200,
        data: {
          evidence: {
            id: "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAA",
            assets: [
              {
                id: "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA",
                kind: "object",
                storage_binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAA",
              },
            ],
          },
          uploads: [
            {
              asset_id: "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA",
              put_url: "http://127.0.0.1/test_upload",
              headers: {},
              expires_at: Date.now() + 60000,
            },
          ],
        },
      }));
      t.mock.method(api.mission, operation, async () => failure);
      assert.equal(
        await hostExecution(input, async (native) => {
          let aborted = false;
          held = native.sshAccess;
          assert.equal(held.size, ONE_ENTRY);
          const unsubscribe = native.context.onCancel(() => {
            aborted = true;
          });
          try {
            await assert.rejects(
              native.hostTools(workspace).evidenceUpload("a.txt", undefined),
              { code },
            );
            assert.ok(aborted);
            assert.ok(native.context.err());
            return { kind: "released", furtherWork: false };
          } finally {
            unsubscribe();
          }
        }),
        null,
      );
      assert.equal(held?.size, NO_ENTRIES);
    }
  }
  t.mock.method(api.worker, "execution.setup.get", async () => ({
    type: OperationResultType.Failure,
    status: 403,
    error: {
      request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      error: {
        code: "gateway.invocation.execution_proof_failed",
        message: "Ended",
        details: null,
      },
    },
  }));
  assert.equal(
    await hostExecution(input, async () => {
      assert.fail("Revoked claim ran");
    }),
    null,
  );
});

const OPENSSH_ARMOR = "OPENSSH PRIVATE KEY";
const KNOWN_HOSTS =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";
const CLONE_DEADLINE_MS = 20000;

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test("host builds the SSH access of each repository from the handover and leaves no key file under the state directory", async (t) => {
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  const key = generateSshKey("deploy");
  const bindingId = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB";
  const origin = join(temporary(t), "origin");
  mkdirSync(origin);
  await simpleGit(origin).init(["--initial-branch=main"]);
  await writeFile(join(origin, "README.md"), "origin");
  await simpleGit(origin).add("README.md");
  await simpleGit(origin).raw([
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  const credential = {
    credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    provider_id: "anthropic",
    credential: { type: "api_key", key: "test_host_key" },
  };
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(
      deriveHandoverKeys(SECRET).handover,
      handoverAad(claim.execution_id, claim.claimant.runtime_identity),
      {
        items: [credential],
        ssh_identities: [
          {
            binding_id: bindingId,
            credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAB",
            private_key: key.private_key,
          },
        ],
      },
    ),
  }));
  t.mock.method(api.worker, "execution.setup.get", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: {
      execution_id: claim.execution_id,
      worker_name: "coder@1",
      agents: [],
      templates: SHIPPED_TEMPLATES,
      resource_budget: { turns: 200, wall_time_ms: 7200000 },
      intent: ExecutionIntent.Implement,
      repositories: [
        {
          binding_id: bindingId,
          name: "repo",
          address: "git@github.com:owner/repo.git",
          ssh_host_key: { known_hosts: KNOWN_HOSTS },
          strategy: { base_branch: "main" },
          project_prompt: null,
          working_layer: WORKING_LAYER_ALL_ON,
        },
      ],
    },
  }));
  const state = temporary(t);
  const workspaces = WorkspaceRoot.open(state);
  const transport = new RepositoryComponent();
  let held: ReadonlyMap<string, SshAccess> | undefined;
  const result = await hostExecution(
    {
      api,
      claim,
      clientSecret: SECRET,
      context: background,
      workspaces,
      transport,
      modelRuntimeFactory: async () => {
        throw new Error("Unexpected inference");
      },
      hostHome: temporary(t),
      env: hostEnvironment(),
      transcript: noTranscript,
      log: () => {},
    },
    async (native) => {
      held = native.sshAccess;
      const access = native.sshAccess.get(bindingId);
      assert.deepEqual(access, {
        private_key: key.private_key,
        public_key: key.public_key,
        known_hosts: KNOWN_HOSTS,
        port: DEFAULT_SSH_PORT,
      });
      const checkout = join(workspaces.root, "checkout");
      mkdirSync(checkout);
      await native.transport.clone(
        origin,
        checkout,
        native.context,
        CLONE_DEADLINE_MS,
        access!,
      );
      return { kind: "released", furtherWork: false };
    },
  );
  assert.equal(result, null);
  assert.equal(held?.size, NO_ENTRIES);
  const files = filesUnder(state);
  assert.ok(files.some((file) => file.endsWith(join(".git", "HEAD"))));
  for (const file of files) {
    const text = readFileSync(file, "latin1");
    assert.equal(text.includes(OPENSSH_ARMOR), false, file);
    assert.equal(text.includes(key.public_key.split(" ")[1]!), false, file);
  }
});

test("host stops an execution whose repository holds no handed SSH identity before the method", async (t) => {
  const api = httpTransport("http://127.0.0.1:1");
  const claim = testClaim();
  t.mock.method(api.worker, "handover", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: sealEnvelope(
      deriveHandoverKeys(SECRET).handover,
      handoverAad(claim.execution_id, claim.claimant.runtime_identity),
      {
        items: [
          {
            credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
            provider_id: "anthropic",
            credential: { type: "api_key", key: "test_host_key" },
          },
        ],
        ssh_identities: [],
      },
    ),
  }));
  t.mock.method(api.worker, "execution.setup.get", async () => ({
    type: OperationResultType.Completed,
    status: 200,
    data: {
      execution_id: claim.execution_id,
      worker_name: "coder@1",
      agents: [],
      templates: SHIPPED_TEMPLATES,
      resource_budget: { turns: 200, wall_time_ms: 7200000 },
      intent: ExecutionIntent.Implement,
      repositories: [
        {
          binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB",
          name: "repo",
          address: "git@github.com:owner/repo.git",
          ssh_host_key: { known_hosts: KNOWN_HOSTS },
          strategy: { base_branch: "main" },
          project_prompt: null,
          working_layer: WORKING_LAYER_ALL_ON,
        },
      ],
    },
  }));
  const result = await hostExecution(
    {
      api,
      claim,
      clientSecret: SECRET,
      context: background,
      workspaces: WorkspaceRoot.open(temporary(t)),
      transport: new RepositoryComponent(),
      modelRuntimeFactory: async () => {
        throw new Error("Unexpected inference");
      },
      hostHome: temporary(t),
      env: hostEnvironment(),
      transcript: noTranscript,
      log: () => {},
    },
    async () => assert.fail("The method must not run."),
  );
  assert.equal(result?.code, UNKNOWN_FAILURE);
});
