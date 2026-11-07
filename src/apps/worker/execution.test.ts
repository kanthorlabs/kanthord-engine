import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { writeFile } from "node:fs/promises";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { background, CancellationContext } from "../../kernel/context.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import {
  deriveHandoverKeys,
  deriveSshSignKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
} from "../../kernel/handover.ts";
import type { Diagnostic } from "../../kernel/errors.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  EndReason,
  type NativeExecutionInput,
  WorkspaceRoot,
} from "../../worker/unit/index.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import type { ExecutionSetup } from "../../worker/contract.ts";
import { httpTransport } from "./transport.ts";
import { testClaim } from "./test-support.ts";
import { hostExecution } from "./execution.ts";
import { pullLoop } from "./pull-loop.ts";
import { Backoff, BACKOFF_INITIAL_MS } from "./api.ts";
import { ChainLevel } from "../../agent/contract.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import { ExecutionIntent } from "../../worker/contract.ts";
import { TEST_SSH_PUBLIC_KEY } from "../../worker/test-support.ts";
import { generateSshKey } from "../../repository/ssh-key.ts";
import type { SshAccess } from "../../repository/contract.ts";
import { DEFAULT_SSH_PORT } from "../../repository/sshd-test-support.ts";

const SECRET = Buffer.alloc(32, 7).toString("base64");
const ENDED_RECORD = "execution ended";
const SESSION_ROOT = "/test/session-root";
const NO_ENTRIES = 0;
const ONE_ENTRY = 1;
const LINK_UPDATE_PAGE_LIMIT = 20;
const REGISTRATION = {
  runtime_identity: "worker_registration_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  resource_identity: "worker:kanthord:test",
  worker_name: "coder@1",
};
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
    sessionRoot: SESSION_ROOT,
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
        enablement_id: null,
        worker_binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB",
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
        prompt: { final: "setup prompt", sources: [] },
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
        resource_identity: "github:kanthorlabs/engine",
        ssh_public_key: TEST_SSH_PUBLIC_KEY,
        strategy: { base_branch: "main" },
        environment: null,
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
    sessionRoot: SESSION_ROOT,
    log: () => {},
  };
  let stored: NativeExecutionInput["credentials"] | undefined;
  assert.equal(
    await hostExecution(input, async (native) => {
      events.push("method");
      stored = native.credentials;
      assert.equal(native.sessionRoot, SESSION_ROOT);
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
    (
      (await hostExecution(input, async () => ({
        kind: "ended",
        ...stop,
      }))) as Diagnostic | null
    )?.code,
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
      (await hostExecution(input, async (native) => {
        stored = native.credentials;
        held = native.sshAccess;
        assert.equal(held.size, ONE_ENTRY);
        throw new Error("test_private_material");
      })) as Diagnostic | null
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
          const cancellation = addAbortListener(native.context.signal, () => {
            aborted = true;
          });
          try {
            await assert.rejects(
              native.hostTools(workspace).evidenceUpload("a.txt", undefined),
              { code },
            );
            assert.ok(aborted);
            assert.ok(native.context.signal.aborted);
            return { kind: "released", furtherWork: false };
          } finally {
            cancellation[Symbol.dispose]();
          }
        }),
        null,
      );
      assert.equal(held?.size, NO_ENTRIES);
    }
  }
  const linkUpdates = { items: [], next_cursor: null, total: NO_ENTRIES };
  const linkUpdateRequests: unknown[] = [];
  t.mock.method(
    api.worker,
    "execution.link_update.get",
    async (request: unknown) => {
      linkUpdateRequests.push(request);
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: linkUpdates,
      };
    },
  );
  assert.equal(
    await hostExecution(input, async (native) => {
      assert.deepEqual(
        await native
          .hostTools(workspace)
          .linkUpdateList({ limit: LINK_UPDATE_PAGE_LIMIT }, undefined),
        linkUpdates,
      );
      return { kind: "released", furtherWork: false };
    }),
    null,
  );
  assert.deepEqual(linkUpdateRequests, [
    {
      params: { execution_id: claim.execution_id },
      query: { limit: LINK_UPDATE_PAGE_LIMIT },
      body: null,
    },
  ]);
  for (const [status, code] of [
    [403, "gateway.invocation.execution_proof_failed"],
    [409, "scheduler.execution.not_running"],
  ] as const) {
    t.mock.method(api.worker, "execution.link_update.get", async () => ({
      type: OperationResultType.Failure,
      status,
      error: {
        request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
        error: { code, message: "Ended", details: null },
      },
    }));
    assert.equal(
      await hostExecution(input, async (native) => {
        await assert.rejects(
          native
            .hostTools(workspace)
            .linkUpdateList({ limit: LINK_UPDATE_PAGE_LIMIT }, undefined),
          { code },
        );
        assert.ok(native.context.signal.aborted);
        return { kind: "released", furtherWork: false };
      }),
      null,
    );
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
const RELAY_BINDING = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const RELAY_DATA = Buffer.from("user authentication request");
const RELAY_SIGNATURE = Buffer.from("relayed signature");
const RELAY_FLAGS = 4;

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
          resource_identity: "github:kanthorlabs/engine",
          ssh_public_key: TEST_SSH_PUBLIC_KEY,
          strategy: { base_branch: "main" },
          environment: null,
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
      sessionRoot: SESSION_ROOT,
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

test("host builds a relay SSH access for a repository whose handover holds no SSH identity", async (t) => {
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
          binding_id: RELAY_BINDING,
          name: "repo",
          address: "git@github.com:owner/repo.git",
          ssh_host_key: { known_hosts: KNOWN_HOSTS },
          resource_identity: "github:kanthorlabs/engine",
          ssh_public_key: TEST_SSH_PUBLIC_KEY,
          strategy: { base_branch: "main" },
          environment: null,
        },
      ],
    },
  }));
  const signKeys = deriveSshSignKeys(SECRET);
  const aad = handoverAad(claim.execution_id, claim.claimant.runtime_identity);
  const signed: unknown[] = [];
  t.mock.method(
    api.worker,
    "ssh.sign",
    async (input: {
      body: { execution_id: string; nonce: string; ciphertext: string };
    }) => {
      assert.equal(input.body.execution_id, claim.execution_id);
      signed.push(
        openEnvelope(signKeys.request, aad, {
          nonce: input.body.nonce,
          ciphertext: input.body.ciphertext,
        }),
      );
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: sealEnvelope(signKeys.answer, aad, {
          signature: RELAY_SIGNATURE.toString("base64"),
        }),
      };
    },
  );
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
      sessionRoot: SESSION_ROOT,
      log: () => {},
    },
    async (native) => {
      const access = native.sshAccess.get(RELAY_BINDING);
      assert.ok(access && "relay" in access);
      assert.equal(access.public_key, TEST_SSH_PUBLIC_KEY);
      assert.equal(access.known_hosts, KNOWN_HOSTS);
      assert.equal(access.port, DEFAULT_SSH_PORT);
      assert.ok(
        (await access.relay(RELAY_DATA, RELAY_FLAGS, native.context)).equals(
          RELAY_SIGNATURE,
        ),
      );
      return { kind: "released", furtherWork: false };
    },
  );
  assert.equal(result, null);
  assert.deepEqual(signed, [
    {
      binding_id: RELAY_BINDING,
      data: RELAY_DATA.toString("base64"),
      flags: RELAY_FLAGS,
    },
  ]);
});

const BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const TWO_PULLS = 2;
const SETUP_REFUSALS = [
  {
    status: 409,
    code: "worker.execution.prompt_not_pinned",
    details: { binding_id: BINDING_ID },
    detail: undefined,
    cause: {
      category: "infrastructure",
      assigner: "rule",
      subcategory: "prompt_record",
    },
  },
  {
    status: 409,
    code: "agent.prompt.source_invalid",
    details: { binding_id: BINDING_ID, reason: "too_large" },
    detail: "too_large",
    cause: {
      category: "prompt",
      assigner: "rule",
      subcategory: "source_invalid",
    },
  },
  {
    status: 409,
    code: "agent.prompt.source_invalid",
    details: { part: "repository", name: "repo", reason: "changed" },
    detail: "changed",
    cause: {
      category: "infrastructure",
      assigner: "rule",
      subcategory: "prompt_record",
    },
  },
  {
    status: 503,
    code: "worker.execution.prompt_record_failed",
    details: { agent_name: "coder" },
    detail: undefined,
    cause: {
      category: "infrastructure",
      assigner: "rule",
      subcategory: "prompt_record",
    },
  },
  {
    status: 422,
    code: "project.bindings.repository.ssh_unreachable",
    details: null,
    detail: undefined,
    cause: {
      category: "infrastructure",
      assigner: "rule",
      subcategory: "network",
    },
  },
  {
    status: 409,
    code: "worker.execution.credential_not_pinned",
    details: null,
    detail: undefined,
    cause: {
      category: "unattributed",
      assigner: "rule",
      suspects: ["worker_action", "infrastructure"],
    },
  },
];

function failureAnswer(refusal: {
  status: number;
  code: string;
  details: unknown;
}) {
  return {
    type: OperationResultType.Failure,
    status: refusal.status,
    error: {
      request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      error: {
        code: refusal.code,
        message: "test refusal",
        details: refusal.details,
      },
    },
  };
}

function instantBackoff(t: TestContext) {
  const backoff = new Backoff();
  const delays: number[] = [];
  const next = backoff.next.bind(backoff);
  t.mock.method(backoff, "next", () => {
    delays.push(next());
    return NO_ENTRIES;
  });
  return { backoff, delays };
}

function refusedSetupHost(
  t: TestContext,
  refusal: { status: number; code: string; details: unknown },
  releaseAnswer?: unknown,
  entry: {
    handover?: unknown;
    setup?: unknown;
    lifetime?: number;
    pulls?: number;
    backoff?: Backoff;
  } = {},
) {
  const api = httpTransport("http://127.0.0.1:1");
  const shutdown = new CancellationContext();
  const realNow = Date.now.bind(Date);
  let clockJump = 0;
  t.mock.method(Date, "now", () => realNow() + clockJump);
  const claim = {
    ...testClaim(),
    ...(entry.lifetime === undefined
      ? {}
      : { expired_at: Date.now() + entry.lifetime }),
  };
  const releases: unknown[] = [];
  const events: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const setups: unknown[] = [];
  let pulls = 0;
  t.mock.method(api.scheduler, "workPull", async () => {
    if (++pulls === (entry.pulls ?? TWO_PULLS)) {
      shutdown.cancel();
      return { type: OperationResultType.Indeterminate };
    }
    return {
      type: OperationResultType.Completed,
      status: 200,
      data: { kind: "claimed", execution: claim },
    };
  });
  t.mock.method(
    api.worker,
    "handover",
    async () =>
      entry.handover ?? {
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
      },
  );
  t.mock.method(
    api.worker,
    "execution.setup.get",
    async (request: { params: unknown }) => {
      setups.push(request.params);
      clockJump = entry.lifetime ?? 0;
      return entry.setup ?? failureAnswer(refusal);
    },
  );
  t.mock.method(api.worker, "credential", async () => {
    events.push("credential");
    return { type: OperationResultType.Completed, status: 200, data: null };
  });
  t.mock.method(
    api.scheduler,
    "executionRelease",
    async (request: { body: unknown }) => {
      releases.push(request.body);
      events.push("release");
      if (releaseAnswer) return releaseAnswer;
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: { execution_id: claim.execution_id, ended_at: Date.now() },
      };
    },
  );
  const running = pullLoop({
    api,
    registration: REGISTRATION,
    backoff: entry.backoff ?? instantBackoff(t).backoff,
    shutdown,
    host: (execution) =>
      hostExecution(
        {
          api,
          claim: execution,
          clientSecret: SECRET,
          context: shutdown,
          workspaces: WorkspaceRoot.open(temporary(t)),
          transport: new RepositoryComponent(),
          modelRuntimeFactory: async () => {
            throw new Error("Unexpected inference");
          },
          hostHome: temporary(t),
          env: hostEnvironment(),
          sessionRoot: SESSION_ROOT,
          log: (record) => logs.push(record),
        },
        async () => assert.fail("Refused setup ran the method"),
      ),
    register: async () => REGISTRATION,
    pulling: () => {},
    claimed: () => {},
  });
  return {
    running,
    releases,
    events,
    logs,
    setups,
    pulls: () => pulls,
  };
}

test("a refused setup releases one stop with the cause of its code and the pull loop takes the next work", async (t) => {
  for (const refusal of SETUP_REFUSALS) {
    const host = refusedSetupHost(t, refusal);
    assert.equal(await host.running, null, refusal.code);
    assert.equal(host.pulls(), TWO_PULLS, refusal.code);
    assert.deepEqual(
      host.releases,
      [
        {
          further_work: true,
          stop: {
            reason: EndReason.OperationFailed,
            code: refusal.code,
            ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
            cause: refusal.cause,
          },
        },
      ],
      refusal.code,
    );
    assert.deepEqual(host.events, ["credential", "release"], refusal.code);
  }
});

test("a setup answer that ends the execution releases no stop and the pull loop takes the next work", async (t) => {
  const host = refusedSetupHost(t, {
    status: 409,
    code: "scheduler.execution.not_running",
    details: null,
  });
  assert.equal(await host.running, null);
  assert.equal(host.pulls(), TWO_PULLS);
  assert.deepEqual(host.releases, []);
});

test("a refused setup whose release fails ends the pull loop with the setup code", async (t) => {
  const code = "worker.execution.prompt_not_pinned";
  const host = refusedSetupHost(
    t,
    { status: 409, code, details: { binding_id: BINDING_ID } },
    {
      type: OperationResultType.Failure,
      status: 500,
      error: {
        request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
        error: {
          code: "system.operation.unknown",
          message: "test failure",
          details: null,
        },
      },
    },
  );
  assert.equal((await host.running)?.code, code);
  assert.equal(host.pulls(), ONE_ENTRY);
  assert.equal(host.releases.length, ONE_ENTRY);
});

const SETUP_UNAVAILABLE_RECORD = "worker.execution.setup_unavailable";
const CLAIM_LIFETIME_MS = 60_000;
const GATEWAY_ANSWERS = [
  { status: 504, code: "gateway.invocation.timeout", details: null },
  { status: 500, code: "gateway.invocation.unknown", details: null },
  { status: 503, code: "gateway.invocation.stopping", details: null },
  { status: 401, code: "gateway.authentication.unauthorized", details: null },
];

function releasedStop(release: unknown) {
  const { further_work, stop } = release as {
    further_work: boolean;
    stop: { reason: string; code: string };
  };
  return { further_work, reason: stop.reason, code: stop.code };
}

function unavailableRecords(logs: Record<string, unknown>[]) {
  return logs
    .filter((record) => record.msg === SETUP_UNAVAILABLE_RECORD)
    .map(({ code }) => code);
}

test("a gateway answer of the setup ends only the execution and the pull loop takes the next work", async (t) => {
  for (const answer of GATEWAY_ANSWERS) {
    const host = refusedSetupHost(t, answer);
    assert.equal(await host.running, null, answer.code);
    assert.equal(host.pulls(), TWO_PULLS, answer.code);
    assert.deepEqual(host.releases, [], answer.code);
    assert.deepEqual(unavailableRecords(host.logs), [answer.code]);
  }
});

test("a setup read that stays indeterminate until expired_at ends only the execution and the pull loop takes the next work", async (t) => {
  const host = refusedSetupHost(t, GATEWAY_ANSWERS[0]!, undefined, {
    setup: { type: OperationResultType.Indeterminate },
    lifetime: CLAIM_LIFETIME_MS,
  });
  assert.equal(await host.running, null);
  assert.equal(host.pulls(), TWO_PULLS);
  assert.deepEqual(host.releases, []);
  assert.deepEqual(unavailableRecords(host.logs), [
    "gateway.invocation.timeout",
  ]);
});

test("a handover that the handover key does not open releases a stop with worker.handover.decryption_failed and the pull loop takes the next work", async (t) => {
  const claim = testClaim();
  const host = refusedSetupHost(t, GATEWAY_ANSWERS[0]!, undefined, {
    handover: {
      type: OperationResultType.Completed,
      status: 200,
      data: sealEnvelope(
        deriveHandoverKeys(Buffer.alloc(32, 9).toString("base64")).handover,
        handoverAad(claim.execution_id, claim.claimant.runtime_identity),
        { items: [], ssh_identities: [] },
      ),
    },
  });
  assert.equal(await host.running, null);
  assert.equal(host.pulls(), TWO_PULLS);
  assert.equal(host.releases.length, ONE_ENTRY);
  assert.deepEqual(releasedStop(host.releases[0]), {
    further_work: true,
    reason: EndReason.OperationFailed,
    code: "worker.handover.decryption_failed",
  });
  assert.deepEqual(host.events, ["release"]);
});

test("a service refusal of the handover releases a stop with its code and the pull loop takes the next work", async (t) => {
  const code = "credential.revision.revoked";
  const host = refusedSetupHost(t, GATEWAY_ANSWERS[0]!, undefined, {
    handover: failureAnswer({ status: 409, code, details: null }),
  });
  assert.equal(await host.running, null);
  assert.equal(host.pulls(), TWO_PULLS);
  assert.equal(host.releases.length, ONE_ENTRY);
  assert.deepEqual(releasedStop(host.releases[0]), {
    further_work: true,
    reason: EndReason.OperationFailed,
    code,
  });
  assert.deepEqual(host.events, ["release"]);
});

test("a gateway answer of the handover ends only the execution and the pull loop takes the next work", async (t) => {
  for (const answer of GATEWAY_ANSWERS) {
    const host = refusedSetupHost(t, answer, undefined, {
      handover: failureAnswer(answer),
    });
    assert.equal(await host.running, null, answer.code);
    assert.equal(host.pulls(), TWO_PULLS, answer.code);
    assert.deepEqual(host.releases, [], answer.code);
    assert.deepEqual(unavailableRecords(host.logs), [answer.code]);
  }
});

const THREE_PULLS = 3;
const BACKOFF_GROWTH = 2;

test("a persistent gateway answer of the setup re-pulls the same claim after a growing pull backoff", async (t) => {
  const { backoff, delays } = instantBackoff(t);
  const reset = t.mock.method(backoff, "reset");
  const answer = GATEWAY_ANSWERS[1]!;
  const host = refusedSetupHost(t, answer, undefined, {
    pulls: THREE_PULLS,
    backoff,
  });
  assert.equal(await host.running, null);
  assert.equal(host.pulls(), THREE_PULLS);
  assert.deepEqual(delays, [
    BACKOFF_INITIAL_MS,
    BACKOFF_INITIAL_MS * BACKOFF_GROWTH,
  ]);
  assert.equal(reset.mock.callCount(), NO_ENTRIES);
  assert.equal(host.setups.length, TWO_PULLS);
  assert.deepEqual(host.setups[0], host.setups[1]);
  assert.deepEqual(unavailableRecords(host.logs), [answer.code, answer.code]);
  assert.deepEqual(host.releases, []);
});

test("a host that reaches setup resets the pull backoff", async (t) => {
  const backoff = new Backoff();
  const reset = t.mock.method(backoff, "reset");
  const host = refusedSetupHost(t, SETUP_REFUSALS[0]!, undefined, {
    backoff,
  });
  assert.equal(await host.running, null);
  assert.equal(reset.mock.callCount(), ONE_ENTRY);
});
