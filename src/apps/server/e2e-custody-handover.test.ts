import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse, stringify } from "yaml";
import { ulid } from "ulid";
import { configuration, CONFIG_VERSION } from "../../config/index.ts";
import {
  handoverPayloadSchema,
  type CredentialAnswer,
} from "../../custody/contract.ts";
import { Intent } from "../../mission/contract.ts";
import { httpClient } from "../../gateway/client.ts";
import { background } from "../../kernel/context.ts";
import { writePrivate } from "../../kernel/files.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  HandoverOpenError,
  openEnvelope,
  sealEnvelope,
  type HandoverEnvelope,
} from "../../kernel/handover.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { ulidSchema } from "../../kernel/identity.ts";
import { digest } from "../../kernel/json.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  type ExecutionRecord,
  WorkPullKind,
} from "../../scheduler/contract.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import { gitLsRemote } from "../../repository/connector.ts";
import {
  createBareRepository,
  startTestSshd,
} from "../../repository/test-sshd.ts";
import { workerOperations } from "../../worker/contract.ts";
import { environment, kanthord, kanthordTerminal } from "./cli-support.ts";
import {
  createFakeSshCredential,
  FAKE_SSH_CREDENTIAL,
  gatewayFixture,
  COVERING_WORKER_BINDINGS,
  enableCoveringAgents,
} from "./test-support.ts";

const SUCCESS = 0;
const FAILURE = 1;
const FIRST_REVISION = 1;
const SINGLE_INSTANCE = 1;
const SECOND_REVISION = 2;
const FULL_BINDING_SET_VERSION = 5;
const THIRD_CREDENTIAL_REVISION = 3;
const INVALID_REPORT_COUNT = 4;
const STRING_TYPE = "string";
const NUMBER_TYPE = "number";
const HANDOVER_LOG_MESSAGE = "credential handover";
const NO_OUTPUT = "";
const MISSING_TOKEN = "";
const JOURNEY_TIMEOUT = 180000;
const SSH_TIMEOUT = 30000;
const UNKNOWN_EXECUTION = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const NAME = "anthro-1";
const PROVIDER = "anthropic";
const SECRETS = [
  "e2e-handover-secret-one",
  "e2e-handover-secret-two",
  "e2e-handover-secret-three",
  "e2e-handover-refreshed",
  "e2e-handover-second",
  "e2e-handover-third",
] as const;
const [FIRST, SECOND, THIRD, REFRESHED, NEXT, LAST] = SECRETS;
const CONFIGURATION = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
} as const;
const CONTENT = {
  name: "Recover accounts",
  requirement: "Recover accounts",
  criterion: "Accounts recover",
  verifications: ["true"],
  bindings: [],
};
type Pull = { kind: string; execution: ExecutionRecord };
type Change = { revisions: { node_id: string }[] };
const credential = (key: string) => ({ type: "api_key" as const, key });

function noSecrets(text: string): void {
  assert.equal(typeof text, STRING_TYPE);
  assert.ok(SECRETS.every((secret) => !text.includes(secret)));
}

function completed<T>(result: OperationResult<T>): T {
  assert.equal(result.type, OperationResultType.Completed);
  assert.ok(result.type === OperationResultType.Completed);
  return result.data;
}

function refused(
  result: OperationResult<unknown>,
  status: number,
  code: string,
): void {
  assert.equal(result.type, OperationResultType.Failure);
  assert.ok(result.type === OperationResultType.Failure);
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
  noSecrets(JSON.stringify(result));
}

function cli(directory: string, env: NodeJS.ProcessEnv) {
  let sequence = 0;
  const read = async <T>(args: string[], caller = env): Promise<T> => {
    const result = await kanthord(args, caller);
    assert.equal(result.code, SUCCESS, result.stderr);
    assert.equal(result.stderr, NO_OUTPUT);
    noSecrets(result.stdout);
    return JSON.parse(result.stdout) as T;
  };
  const write = <T>(args: string[], body: unknown, caller = env) => {
    assert.ok(directory.startsWith("/"));
    assert.ok(args.length);
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return read<T>([...args, "--file", path], caller);
  };
  const refuses = async (args: string[], code: string, caller = env) => {
    const result = await kanthord(args, caller);
    assert.equal(result.code, FAILURE, result.stderr);
    assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
    assert.equal(result.stdout, NO_OUTPUT);
    noSecrets(result.stderr);
  };
  return { read, write, refuses, env };
}

async function machine(
  directory: string,
  projectId: string,
  name: string,
  env: NodeJS.ProcessEnv,
) {
  const args = [
    "auth",
    "jwt",
    "generate",
    "--project",
    projectId,
    "--binding",
    "general",
    "--name",
    name,
    "--config",
    join(directory, "server.yaml"),
  ];
  const result = await kanthordTerminal(args, env);
  assert.equal(result.code, SUCCESS, result.stderr);
  assert.equal(result.stderr, NO_OUTPUT);
  const fragment = parse(result.stdout) as {
    token: string;
    client_secret: string;
  };
  assert.ok(fragment.token && fragment.client_secret);
  return fragment;
}

async function resources(c: ReturnType<typeof cli>) {
  await c.write(["llm", "credential", "create"], {
    name: NAME,
    platform: PROVIDER,
    metadata: null,
    secret: { key: FIRST },
  });
  await c.write(["repository", "credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: "test-secret" },
  });
  await createFakeSshCredential(c.read);
  await enableCoveringAgents(c.env, {
    platform: PROVIDER,
    credential: NAME,
    configuration: CONFIGURATION,
  });
  const project = await c.read<{ id: string }>([
    "project",
    "create",
    "--name",
    "handover",
  ]);
  const applied = await c.write<{
    binding_set_version: number;
    bindings: Record<string, { id: string }>;
  }>(["project", "binding", "apply", project.id], {
    version: FIRST_REVISION,
    bindings: {
      ...COVERING_WORKER_BINDINGS,
      repo: {
        kind: "repository",
        config: {
          available: true,
          platform: "github",
          address: "git@github.com:owner/repo.git",
          ssh_credential: FAKE_SSH_CREDENTIAL,
          strategy: { base_branch: "main" },
          credential: "github",
        },
      },
      general: {
        kind: "worker",
        config: {
          worker: "coder@1",
          placement: "server",
          instance_count: SINGLE_INSTANCE,
          entries: [{ agent: "swe@1", ...CONFIGURATION }],
        },
      },
    },
  });
  assert.equal(applied.binding_set_version, FULL_BINDING_SET_VERSION);
  return { project_id: project.id, binding_id: applied.bindings.repo!.id };
}

async function graph(
  c: ReturnType<typeof cli>,
  projectId: string,
  bindingId: string,
): Promise<void> {
  const mission = await c.read<{ id: string }>(["mission", "get", projectId]);
  const implement = await c.write<Change>(
    ["mission", "node", "create", mission.id],
    {
      filename: "implement-1.md",
      content: { ...CONTENT, intent: Intent.Implement, bindings: [bindingId] },
      tasks: [],
      reason: "plan",
      expected_mission_version: FIRST_REVISION,
    },
  );
  assert.ok(implement.revisions[0]);
}

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t, {
    fakeSlots: true,
    repositoryConnector: {
      gitLsRemote: async () => {},
    },
  });
  const directory = temporary(t);
  const human = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const c = cli(directory, human);
  const { project_id: projectId, binding_id: bindingId } = await resources(c);
  await graph(c, projectId, bindingId);
  writePrivate(
    join(directory, "server.yaml"),
    stringify(
      configuration({
        version: CONFIG_VERSION,
        master_key: fixture.config.master_key,
      }).getProperties(),
    ),
  );
  const general = await fixture.slotClient(projectId, "general");
  const spare = await machine(directory, projectId, "general-b", human);
  const env = { ...human, KANTHORD_TOKEN: general.token };
  const registration = await c.read<{ runtime_identity: string }>(
    ["worker", "register"],
    env,
  );
  const pull = () =>
    c.write<Pull>(
      ["scheduler", "work", "pull"],
      {
        resource_identity: "worker:kanthord:general",
        runtime_identity: registration.runtime_identity,
      },
      env,
    );
  const claim = await pull();
  assert.equal(claim.kind, WorkPullKind.Claimed);
  const stored = await c.read<CredentialAnswer>([
    "llm",
    "credential",
    "get",
    NAME,
  ]);
  assert.ok(stored.revisions[0]);
  const ssh = await c.read<CredentialAnswer>([
    "repository",
    "credential",
    "get",
    FAKE_SSH_CREDENTIAL,
  ]);
  assert.ok(ssh.revisions[0]);
  const keys = deriveHandoverKeys(general.client_secret);
  t.after(() => {
    keys.handover.fill(0);
    keys.report.fill(0);
  });
  const client = httpClient(workerOperations, fixture.endpoint, general.token);
  const handover = (executionId: string, key = ulid()) =>
    client.handover(
      { params: {}, query: {}, body: { execution_id: executionId } },
      { idempotencyKey: key },
    );
  const report = (executionId: string, envelope: HandoverEnvelope) =>
    client.credential(
      {
        params: {},
        query: {},
        body: { execution_id: executionId, ...envelope },
      },
      { idempotencyKey: ulid() },
    );
  const aad = (executionId: string) =>
    handoverAad(executionId, registration.runtime_identity);
  const open = (executionId: string, envelope: HandoverEnvelope) =>
    handoverPayloadSchema.parse(
      openEnvelope(keys.handover, aad(executionId), envelope),
    );
  const seal = (executionId: string, value: unknown) =>
    sealEnvelope(keys.report, aad(executionId), value);
  return {
    ...c,
    fixture,
    env,
    human,
    spare,
    keys,
    aad,
    open,
    seal,
    handover,
    report,
    pull,
    execution_id: claim.execution.execution_id,
    credentialId: stored.revisions[0].id,
    bindingId,
    sshCredentialId: ssh.revisions[0].id,
    sshPublicKey: String(ssh.revisions[0].metadata?.public_key),
  };
}

test(
  "E05 custody handover CLI and encrypted report journey",
  { timeout: JOURNEY_TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const X = h.execution_id;
    const C1 = h.credentialId;
    const K1 = ulid();
    const S = h.sshCredentialId;
    let S2: string;
    let pinnedKey: string;
    let C2: string;
    let X2: string;
    const R1 = {
      credential_id: C1,
      digest: digest(credential(FIRST)),
      credential: credential(REFRESHED),
    };
    const R2 = {
      credential_id: C1,
      digest: digest(credential(REFRESHED)),
      credential: credential(NEXT),
    };

    await t.test(
      "E05.1 CLI prints only receipt and pins the first revision",
      async () => {
        const receipt = await h.read<{
          received: boolean;
          idempotency_key: string;
        }>(["worker", "handover", X], h.env);
        assert.deepEqual(Object.keys(receipt).sort(), [
          "idempotency_key",
          "received",
        ]);
        assert.equal(receipt.received, true);
        assert.ok(ulidSchema.safeParse(receipt.idempotency_key).success);
        const execution = await h.read<ExecutionRecord>([
          "scheduler",
          "execution",
          "get",
          X,
        ]);
        assert.deepEqual(execution.credentials.toSorted(), [C1, S].toSorted());
      },
    );
    await t.test(
      "E05.2 only the handover key and execution AAD open the envelope",
      async () => {
        const envelope = completed(await h.handover(X, K1));
        const payload = h.open(X, envelope);
        assert.deepEqual(payload.items, [
          {
            credential_id: C1,
            provider_id: PROVIDER,
            credential: credential(FIRST),
          },
        ]);
        assert.deepEqual(
          payload.ssh_identities.map(({ binding_id, credential_id }) => ({
            binding_id,
            credential_id,
          })),
          [{ binding_id: h.bindingId, credential_id: S }],
        );
        assert.throws(
          () =>
            openEnvelope(h.keys.handover, h.aad(UNKNOWN_EXECUTION), envelope),
          HandoverOpenError,
        );
        assert.throws(
          () => openEnvelope(h.keys.report, h.aad(X), envelope),
          HandoverOpenError,
        );
        assert.ok(
          h.fixture.logs
            .map((line) => JSON.parse(line))
            .some(
              (record) =>
                record.msg === HANDOVER_LOG_MESSAGE &&
                record.execution_id === X &&
                record.credential_id === C1,
            ),
        );
        noSecrets(JSON.stringify(h.fixture.logs));
      },
    );
    await t.test(
      "E05.2a the handed SSH key authenticates to an sshd that pins its public key",
      async (tt) => {
        const [identity] = h.open(
          X,
          completed(await h.handover(X)),
        ).ssh_identities;
        assert.ok(identity);
        pinnedKey = identity.private_key;
        const sshd = await startTestSshd(tt);
        const bare = await createBareRepository(tt);
        const access = RepositoryComponent.handedSshAccess(
          identity.private_key,
          sshd.known_hosts,
          sshd.port,
        );
        assert.equal(access.public_key.trim(), h.sshPublicKey.trim());
        await assert.rejects(
          gitLsRemote(sshd.url(bare), background, SSH_TIMEOUT, access),
        );
        await sshd.authorize(access.public_key);
        await gitLsRemote(sshd.url(bare), background, SSH_TIMEOUT, access);
        assert.ok(
          !JSON.stringify(h.fixture.logs).includes(identity.private_key),
        );
      },
    );
    await t.test(
      "E05.3 replay loses its envelope while a fresh key reads the same pin",
      async () => {
        const replay = await h.handover(X, K1);
        assert.equal(replay.type, OperationResultType.Failure);
        assert.ok(replay.type === OperationResultType.Failure);
        assert.equal(replay.status, HttpStatus.Conflict);
        assert.ok(!JSON.stringify(replay).includes("ciphertext"));
        assert.equal(
          h.open(X, completed(await h.handover(X))).items[0]?.credential_id,
          C1,
        );
      },
    );
    await t.test(
      "E05.4 rotation retains the pinned older revision",
      async () => {
        await h.write(["llm", "credential", "rotate", NAME], {
          expected_revision: FIRST_REVISION,
          secret: { key: SECOND },
        });
        const stored = await h.read<CredentialAnswer>([
          "llm",
          "credential",
          "get",
          NAME,
        ]);
        assert.deepEqual(
          stored.revisions.map((row) => [row.revision, row.ended_at]),
          [
            [SECOND_REVISION, null],
            [FIRST_REVISION, null],
          ],
        );
        C2 = stored.revisions[0]!.id;
        assert.deepEqual(h.open(X, completed(await h.handover(X))).items[0], {
          credential_id: C1,
          provider_id: PROVIDER,
          credential: credential(FIRST),
        });
      },
    );
    await t.test(
      "E05.4a SSH key rotation keeps the pinned key of the running execution",
      async () => {
        await h.read([
          "repository",
          "credential",
          "ssh-key-rotate",
          FAKE_SSH_CREDENTIAL,
          "--expected-revision",
          String(FIRST_REVISION),
        ]);
        const stored = await h.read<CredentialAnswer>([
          "repository",
          "credential",
          "get",
          FAKE_SSH_CREDENTIAL,
        ]);
        assert.deepEqual(
          stored.revisions.map((row) => [row.revision, row.ended_at]),
          [
            [SECOND_REVISION, null],
            [FIRST_REVISION, null],
          ],
        );
        S2 = stored.revisions[0]!.id;
        const [identity] = h.open(
          X,
          completed(await h.handover(X)),
        ).ssh_identities;
        assert.equal(identity?.credential_id, S);
        assert.equal(identity?.private_key, pinnedKey);
      },
    );
    await t.test(
      "E05.5 refresh updates in place and stale digest reports do not overwrite",
      async () => {
        for (const value of [R1, R2, R1])
          assert.equal(completed(await h.report(X, h.seal(X, value))), null);
        assert.deepEqual(
          h.open(X, completed(await h.handover(X))).items[0]?.credential,
          credential(NEXT),
        );
        const stored = await h.read<CredentialAnswer>([
          "llm",
          "credential",
          "get",
          NAME,
        ]);
        assert.deepEqual(
          stored.revisions.map((row) => row.revision),
          [SECOND_REVISION, FIRST_REVISION],
        );
      },
    );
    await t.test(
      "E05.6 invalid direction, truncation, pin and type refuse",
      async () => {
        const envelopes = [
          sealEnvelope(h.keys.handover, h.aad(X), R2),
          { nonce: h.seal(X, R2).nonce, ciphertext: "AAAA" },
          h.seal(X, { ...R2, credential_id: C2 }),
          h.seal(X, {
            ...R2,
            credential: {
              type: "oauth",
              refresh: "r",
              access: "a",
              expires: FIRST_REVISION,
            },
          }),
        ];
        assert.equal(envelopes.length, INVALID_REPORT_COUNT);
        for (const envelope of envelopes)
          refused(
            await h.report(X, envelope),
            HttpStatus.BadRequest,
            "custody.handover.report_invalid",
          );
      },
    );
    await t.test(
      "E05.7 CLI validates caller, proof, argument, mutation key and token",
      async () => {
        await h.refuses(
          ["worker", "handover", X],
          "gateway.authentication.unauthorized",
        );
        await h.refuses(
          ["worker", "handover", X, "--token", h.spare.token],
          "gateway.registration.required",
        );
        await h.refuses(
          ["worker", "handover", UNKNOWN_EXECUTION],
          "gateway.invocation.execution_proof_failed",
          h.env,
        );
        await h.refuses(
          ["worker", "handover", "invalid"],
          "cli.worker.handover.invalid_execution_id",
          h.env,
        );
        await h.refuses(
          ["worker", "handover", X, "--idempotency-key", "bad"],
          "cli.idempotency_key.invalid",
          h.env,
        );
        await h.refuses(
          ["worker", "handover", X],
          "cli.worker.handover.token_required",
          { ...h.env, KANTHORD_TOKEN: MISSING_TOKEN },
        );
      },
    );
    await t.test(
      "E05.8 revoke refuses both handover and refresh of the pin",
      async () => {
        await h.read([
          "llm",
          "credential",
          "revoke",
          NAME,
          String(FIRST_REVISION),
        ]);
        const stored = await h.read<CredentialAnswer>([
          "llm",
          "credential",
          "get",
          NAME,
        ]);
        assert.equal(stored.revisions[0]?.ended_at, null);
        assert.equal(typeof stored.revisions[1]?.ended_at, NUMBER_TYPE);
        await h.refuses(
          ["worker", "handover", X],
          "credential.revision.revoked",
          h.env,
        );
        refused(
          await h.report(
            X,
            h.seal(X, {
              credential_id: C1,
              digest: digest(credential(NEXT)),
              credential: credential(LAST),
            }),
          ),
          HttpStatus.Conflict,
          "credential.revision.revoked",
        );
      },
    );
    await t.test(
      "E05.9 released execution loses both handover and report proof",
      async () => {
        await h.write(
          ["scheduler", "execution", "release", X],
          { further_work: true },
          h.env,
        );
        const execution = await h.read<ExecutionRecord>([
          "scheduler",
          "execution",
          "get",
          X,
        ]);
        assert.equal(typeof execution.ended_at, NUMBER_TYPE);
        await h.refuses(
          ["worker", "handover", X],
          "gateway.invocation.execution_proof_failed",
          h.env,
        );
        refused(
          await h.report(X, h.seal(X, R2)),
          HttpStatus.Forbidden,
          "gateway.invocation.execution_proof_failed",
        );
      },
    );
    await t.test(
      "E05.10 a new execution pins revision two and keeps it through rotation",
      async () => {
        const claim = await h.pull();
        assert.equal(claim.kind, WorkPullKind.Claimed);
        X2 = claim.execution.execution_id;
        const receipt = await h.read<{ received: boolean }>(
          ["worker", "handover", X2],
          h.env,
        );
        assert.equal(receipt.received, true);
        const execution = await h.read<ExecutionRecord>([
          "scheduler",
          "execution",
          "get",
          X2,
        ]);
        assert.deepEqual(execution.credentials.toSorted(), [C2, S2].toSorted());
        const [identity] = h.open(
          X2,
          completed(await h.handover(X2)),
        ).ssh_identities;
        assert.equal(identity?.credential_id, S2);
        assert.notEqual(identity?.private_key, pinnedKey);
        await h.write(["llm", "credential", "rotate", NAME], {
          expected_revision: SECOND_REVISION,
          secret: { key: THIRD },
        });
        const stored = await h.read<CredentialAnswer>([
          "llm",
          "credential",
          "get",
          NAME,
        ]);
        assert.deepEqual(
          stored.revisions
            .slice(0, SECOND_REVISION)
            .map((row) => [row.revision, row.ended_at]),
          [
            [THIRD_CREDENTIAL_REVISION, null],
            [SECOND_REVISION, null],
          ],
        );
      },
    );
    await t.test(
      "E05.11 credential read drains revision two after its last holder releases",
      async () => {
        await h.write(
          ["scheduler", "execution", "release", X2],
          { further_work: true },
          h.env,
        );
        const stored = await h.read<CredentialAnswer>([
          "llm",
          "credential",
          "get",
          NAME,
        ]);
        assert.equal(stored.revisions[0]?.revision, THIRD_CREDENTIAL_REVISION);
        assert.equal(stored.revisions[0]?.ended_at, null);
        assert.equal(typeof stored.revisions[1]?.ended_at, NUMBER_TYPE);
      },
    );
    await t.test(
      "E05.12 disabled enablement refuses handover before creating a pin",
      async () => {
        const claim = await h.pull();
        assert.equal(claim.kind, WorkPullKind.Claimed);
        await h.read([
          "agent",
          "enablement",
          "disable",
          "swe@1",
          "--expected-revision",
          String(FIRST_REVISION),
        ]);
        await h.refuses(
          ["worker", "handover", claim.execution.execution_id],
          "agent.enablement.unavailable",
          h.env,
        );
        const execution = await h.read<ExecutionRecord>([
          "scheduler",
          "execution",
          "get",
          claim.execution.execution_id,
        ]);
        assert.deepEqual(execution.credentials, []);
        noSecrets(JSON.stringify(h.fixture.logs));
      },
    );
  },
);
