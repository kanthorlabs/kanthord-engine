import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { z } from "zod";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { digest } from "../kernel/json.ts";
import {
  deriveHandoverKeys,
  deriveSshSignKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
  HandoverOpenError,
} from "../kernel/handover.ts";
import { redactionPaths } from "../kernel/log.ts";
import { custodyMigrations } from "./migrations.ts";
import { CustodyComponent } from "./service.ts";
import {
  CUSTODY_HOLDER_REFUSED,
  CUSTODY_REPORT_INVALID,
  REVISION_REVOKED,
  SSH_SIGN_INVALID,
} from "./handover.ts";
import {
  CUSTODY_SERVICE_NAME,
  handoverPayloadSchema,
  HandoverPlacement,
  HolderRefusal,
  SecretShape,
  SshIdentitySubjectKind,
  sshSignAnswerSchema,
  type CredentialPlatformSet,
  type CustodyExecution,
  type SshIdentityAuthorization,
} from "./contract.ts";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import { RepositoryComponent } from "../repository/index.ts";
import { generateSshKey, sshPublicKeyOf } from "../repository/ssh-key.ts";
import {
  RepositoryErrorCode,
  SshSignErrorCode,
  SshSignRefusal,
} from "../repository/contract.ts";
import {
  knownHostsKeyBlob,
  sshSignatureVerifies,
  userAuthenticationData,
} from "../repository/test-sshd.ts";
import { sshPublicKeyBlob } from "../repository/ssh-key.ts";

const SECRET = Buffer.alloc(32, 9).toString("base64");
const FIRST = { type: SecretShape.ApiKey, key: "private-first" };
const SECOND = { type: SecretShape.ApiKey, key: "private-second" };
const NOW = 1000;
const REVISION_COUNT = 1;
const TEST_PLATFORM = "key-platform";
const SSH_PLATFORM = "ssh-platform";
const SSH_ADDRESS = "git@github.com:owner/repository.git";
const KNOWN_HOSTS = "github.com ssh-ed25519 AAAAhost\n";
const OPENSSH_LABEL = "OPENSSH PRIVATE KEY";
const SSH_HANDOVER_RECORD = "ssh identity handover";
const SSH_SIGN_RECORD = "ssh signature relay";
const RSA_SHA2_512 = 4;
const FIRST_SSH_REVISION = 1;
const TEST_SET: CredentialPlatformSet = {
  platforms: {
    [TEST_PLATFORM]: {
      secret_shape: SecretShape.ApiKey,
      login_modes: [],
      metadata_schema: null,
      capability: "none",
      probe: null,
    },
    [SSH_PLATFORM]: {
      secret_shape: SecretShape.SshKey,
      login_modes: [],
      metadata_schema: z.strictObject({ public_key: z.string() }),
      capability: "ssh identity",
      probe: null,
    },
  },
};

function fixture(
  t: TestContext,
  names: readonly string[] = ["anthro-1"],
  repositories: readonly string[] = [],
) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  const logs: string[] = [];
  const logger = pino(
    { redact: redactionPaths },
    {
      write: (line) => {
        logs.push(line);
      },
    },
  );
  const row: CustodyExecution = {
    execution_id: createIdentity("execution"),
    project_id: createIdentity("project"),
    worker_binding_id: createIdentity("binding"),
    resource_identity: "worker:kanthord:general",
    runtime_identity: createIdentity("worker_registration"),
    credentials: [],
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      projectId: row.project_id,
      resourceIdentity: row.resource_identity,
      name: "machine",
      issuedAt: 0,
    },
    "jti",
    row.runtime_identity,
  );
  let running = true;
  let authorized = true;
  const claim: ExecutionClaim = {
    executionId: row.execution_id,
    projectId: row.project_id,
    nodeId: createIdentity("node"),
    attempt: 1,
    pinnedRevision: 1,
    nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    runtimeIdentity: row.runtime_identity,
    workerBindingId: row.worker_binding_id,
  };
  const bindings = new Map(
    repositories.map((credential) => [createIdentity("binding"), credential]),
  );
  const sshIdentityAuthorization: SshIdentityAuthorization = {
    sshIdentity: (tx, _identity, subject, received) => {
      assert(tx.database.isTransaction);
      assert.equal(subject.kind, SshIdentitySubjectKind.Binding);
      assert.equal(received, claim);
      const credential = bindings.get(subject.binding_id);
      if (credential === undefined)
        throw new OperationError(
          HttpStatus.Forbidden,
          "project.authorization.refused",
          "Refused.",
        );
      return {
        credential,
        platform: SSH_PLATFORM,
        project_id: row.project_id,
        facts: { binding_id: subject.binding_id, address: SSH_ADDRESS },
      };
    },
  };
  const repository = new RepositoryComponent({
    checkTools: () => {},
    knownHostsOf: () => KNOWN_HOSTS,
  });
  const component = new CustodyComponent({
    store,
    logger,
    envelopeKey: Buffer.alloc(32, 7),
    clientSecret: () => SECRET,
    bindingsNaming: () => [],
    inboundsNaming: () => [],
    intakeServiceName: INTAKE_SERVICE_NAME,
    agentProvidersDependentOn: () => [],
    platforms: TEST_SET.platforms,
    executions: {
      requireRunning: (tx, executionId, runtimeIdentity) => {
        assert(tx.database.isTransaction);
        assert.equal(executionId, row.execution_id);
        assert.equal(runtimeIdentity, row.runtime_identity);
        if (!running)
          throw new OperationError(
            HttpStatus.Conflict,
            "scheduler.execution.not_running",
            "Execution is not running.",
          );
        return { ...row, credentials: [...row.credentials] };
      },
      pinCredential: (_tx, _id, credentialId) => {
        row.credentials.push(credentialId);
      },
      liveExecutionsPinning: (_tx, id) =>
        row.credentials.includes(id) ? [row.execution_id] : [],
    },
    authorization: {
      authorizeModelInference: () => {
        if (!authorized)
          throw new OperationError(
            HttpStatus.Forbidden,
            "worker.authorization.refused",
            "Refused.",
          );
        return names.map((credential) => ({
          credential,
          platform: TEST_PLATFORM,
          provider_id: TEST_PLATFORM,
          agent_provider: "default",
        }));
      },
    },
    missionAuthorization: {
      frozenAction: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      requestEvidence: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      evidenceAsset: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      objectPut: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
    },
    sshIdentityAuthorization,
    sshAccessOf: (tx, granted, material) =>
      repository.sshAccessOf(tx, granted, material),
    sshSignatureOf: (tx, granted, material, data) =>
      repository.sshSignatureOf(tx, granted, material, data),
  });
  const credentialIds = names.map(
    (name) =>
      store.transaction((tx) =>
        component.create(
          tx,
          TEST_SET,
          {
            name,
            platform: TEST_PLATFORM,
            metadata: null,
            secret: { key: FIRST.key },
          },
          undefined,
        ),
      ).revisions[0]!.id,
  );
  const credentialId = credentialIds[0]!;
  const sshKeys = new Map<string, string>();
  for (const credential of new Set(repositories))
    store.transaction((tx) =>
      component.createGenerated(
        tx,
        TEST_SET,
        {
          name: credential,
          platform: SSH_PLATFORM,
          generate: (name) => {
            const key = generateSshKey(name);
            sshKeys.set(credential, key.private_key);
            return {
              secret: { private_key: key.private_key },
              metadata: { public_key: key.public_key },
            };
          },
        },
        undefined,
      ),
    );
  const rotateSsh = (credential: string) =>
    store.transaction((tx) =>
      component.rotateGenerated(
        tx,
        TEST_SET,
        credential,
        {
          expected_revision: newestRevision(credential),
          generate: (name) => {
            const key = generateSshKey(name);
            sshKeys.set(credential, key.private_key);
            return {
              secret: { private_key: key.private_key },
              metadata: { public_key: key.public_key },
            };
          },
        },
        undefined,
      ),
    );
  const newestRevision = (credential: string) =>
    (
      store.database
        .prepare(
          "SELECT MAX(revision) AS revision FROM credential WHERE name = ?",
        )
        .get(credential) as { revision: number }
    ).revision;
  const keys = deriveHandoverKeys(SECRET);
  const aad = handoverAad(row.execution_id, row.runtime_identity);
  const handover = (
    bindingIds: readonly string[] = [...bindings.keys()],
    placement: HandoverPlacement = HandoverPlacement.Server,
  ) =>
    store.transaction((tx) =>
      component.handover(tx, identity, claim, placement, bindingIds, NOW),
    );
  const report = (envelope: ReturnType<typeof sealEnvelope>) =>
    store.transaction((tx) =>
      component.report(tx, identity, claim, envelope, NOW),
    );
  const signKeys = deriveSshSignKeys(SECRET);
  const sign = (request: unknown) =>
    store.transaction((tx) =>
      component.sshSign(
        tx,
        identity,
        claim,
        sealEnvelope(signKeys.request, aad, request),
        NOW,
      ),
    );
  const publicKeyOf = (credential: string) =>
    store.transaction((tx) =>
      component.sshPublicKeyOf(tx, claim, credential, NOW),
    );
  const refresh = {
    credential_id: credentialId,
    digest: digest(FIRST),
    credential: SECOND,
  };
  return {
    store,
    component,
    logs,
    row,
    identity,
    credentialId,
    credentialIds,
    keys,
    aad,
    handover,
    report,
    sign,
    signKeys,
    publicKeyOf,
    refresh,
    claim,
    bindings,
    sshKeys,
    rotateSsh,
    setRunning: (value: boolean) => {
      running = value;
    },
    setAuthorized: (value: boolean) => {
      authorized = value;
    },
  };
}

test("handover and refresh reports preserve a single pinned revision and sanitized attribution", (t) => {
  const f = fixture(t);
  const first = f.handover();
  assert.deepEqual(
    handoverPayloadSchema.parse(openEnvelope(f.keys.handover, f.aad, first)),
    {
      items: [
        {
          credential_id: f.credentialId,
          provider_id: TEST_PLATFORM,
          credential: FIRST,
        },
      ],
      ssh_identities: [],
    },
  );
  assert.throws(
    () => openEnvelope(f.keys.report, f.aad, first),
    HandoverOpenError,
  );
  assert.throws(
    () =>
      openEnvelope(
        f.keys.handover,
        handoverAad("other", f.row.runtime_identity),
        first,
      ),
    HandoverOpenError,
  );
  f.report(sealEnvelope(f.keys.report, f.aad, f.refresh));
  f.report(sealEnvelope(f.keys.report, f.aad, f.refresh));
  const next = handoverPayloadSchema.parse(
    openEnvelope(f.keys.handover, f.aad, f.handover()),
  );
  assert.deepEqual(next.items[0]!.credential, SECOND);
  assert.equal(
    f.store.database.prepare("SELECT COUNT(*) AS count FROM credential").get()!
      .count,
    REVISION_COUNT,
  );
  for (const message of [
    "credential handover",
    "credential report",
    "credential report stale",
  ]) {
    const record = f.logs
      .map((line) => JSON.parse(line))
      .find((line) => line.msg === message);
    assert.equal(record.execution_id, f.row.execution_id);
    assert.equal(record.credential_id, f.credentialId);
    assert.equal(record.client_id, f.identity.clientId);
    assert.equal(record.runtime_identity, f.row.runtime_identity);
  }
  for (const value of [FIRST.key, SECOND.key])
    assert.equal(f.logs.join("").includes(value), false);
});

test("reports refuse authentication, schema, pin and revision failures without material", (t) => {
  const f = fixture(t);
  f.handover();
  const malformed = [
    sealEnvelope(f.keys.handover, f.aad, f.refresh),
    { nonce: "AAAA", ciphertext: "AAAA" },
    sealEnvelope(f.keys.report, f.aad, {
      ...f.refresh,
      credential_id: createIdentity("credential"),
    }),
    sealEnvelope(f.keys.report, f.aad, { ...f.refresh, digest: "malformed" }),
    sealEnvelope(f.keys.report, f.aad, {
      ...f.refresh,
      credential: {
        type: SecretShape.OAuth,
        refresh: "r",
        access: "a",
        expires: 1,
      },
    }),
    sealEnvelope(f.keys.report, f.aad, {
      ...f.refresh,
      credential: { ...SECOND, extra: FIRST.key },
    }),
  ];
  for (const envelope of malformed)
    assert.throws(
      () => f.report(envelope),
      (error) => {
        assert(error instanceof OperationError);
        assert.equal(error.status, HttpStatus.BadRequest);
        assert.equal(error.code, CUSTODY_REPORT_INVALID);
        assert.equal(JSON.stringify(error).includes(FIRST.key), false);
        return true;
      },
    );
  f.store.database
    .prepare("UPDATE credential SET ended_at = ? WHERE id = ?")
    .run(NOW, f.credentialId);
  assert.throws(() => f.report(sealEnvelope(f.keys.report, f.aad, f.refresh)), {
    code: REVISION_REVOKED,
  });
  f.setRunning(false);
  assert.throws(f.handover, { code: "scheduler.execution.not_running" });
  assert.throws(() => f.report({ nonce: "bad", ciphertext: "bad" }), {
    code: "scheduler.execution.not_running",
  });
});

test("authorization refusal reaches no material or pin", (t) => {
  const f = fixture(t);
  f.setAuthorized(false);
  f.store.database
    .prepare("UPDATE credential SET ciphertext = ?")
    .run(Buffer.from("corrupt"));
  assert.throws(f.handover, { code: "worker.authorization.refused" });
  assert.deepEqual(f.row.credentials, []);
});

test("handover seals and pins one item per credential and accepts a refresh of the second", (t) => {
  const f = fixture(t, ["worker-key", "reviewer-key"]);
  const payload = handoverPayloadSchema.parse(
    openEnvelope(f.keys.handover, f.aad, f.handover()),
  );
  assert.deepEqual(
    payload.items.map((item) => item.credential_id),
    f.credentialIds,
  );
  assert.deepEqual(f.row.credentials, f.credentialIds);
  f.report(
    sealEnvelope(f.keys.report, f.aad, {
      ...f.refresh,
      credential_id: f.credentialIds[1]!,
    }),
  );
  const refreshed = handoverPayloadSchema.parse(
    openEnvelope(f.keys.handover, f.aad, f.handover()),
  );
  assert.deepEqual(
    refreshed.items.map((item) => item.credential),
    [FIRST, SECOND],
  );
});

function liveRevisionId(store: Store, credential: string): string {
  return (
    store.database
      .prepare(
        "SELECT id FROM credential WHERE name = ? AND ended_at IS NULL ORDER BY revision DESC LIMIT 1",
      )
      .get(credential) as { id: string }
  ).id;
}

test("a worker placement handover refuses a server-held item with holder_refused and releases nothing", (t) => {
  const f = fixture(t, ["anthro-1"], ["deploy"]);
  f.store.database
    .prepare("UPDATE credential SET ciphertext = ?")
    .run(Buffer.from("corrupt"));
  assert.throws(
    () => f.handover(undefined, HandoverPlacement.Worker),
    (error) => {
      assert(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.Forbidden);
      assert.equal(error.code, CUSTODY_HOLDER_REFUSED);
      assert.deepEqual(error.details, { reason: HolderRefusal.ServerHeld });
      return true;
    },
  );
  assert.deepEqual(f.row.credentials, []);
  assert.deepEqual(
    f.logs
      .map((line) => JSON.parse(line).msg)
      .filter((msg) => msg.endsWith("handover")),
    [],
  );
});

for (const placement of [HandoverPlacement.Server, HandoverPlacement.Container])
  test(`a ${placement} placement handover carries the server-held item and the SSH identities`, (t) => {
    const f = fixture(t, ["anthro-1"], ["deploy"]);
    const payload = handoverPayloadSchema.parse(
      openEnvelope(f.keys.handover, f.aad, f.handover(undefined, placement)),
    );
    assert.deepEqual(payload.items, [
      {
        credential_id: f.credentialId,
        provider_id: TEST_PLATFORM,
        credential: FIRST,
      },
    ]);
    assert.deepEqual(
      payload.ssh_identities.map(({ binding_id }) => binding_id),
      [...f.bindings.keys()],
    );
  });

test("handover carries one SSH identity per repository binding and pins each revision", (t) => {
  const f = fixture(t, ["anthro-1"], ["deploy-a", "deploy-b"]);
  const payload = handoverPayloadSchema.parse(
    openEnvelope(f.keys.handover, f.aad, f.handover()),
  );
  const expected = [...f.bindings].map(([binding_id, credential]) => ({
    binding_id,
    credential_id: liveRevisionId(f.store, credential),
    private_key: f.sshKeys.get(credential)!,
  }));
  assert.deepEqual(payload.ssh_identities, expected);
  assert.equal(payload.items.length, REVISION_COUNT);
  assert.deepEqual(f.row.credentials, [
    f.credentialId,
    ...expected.map((entry) => entry.credential_id),
  ]);
  const handed = f.logs
    .map((line) => JSON.parse(line))
    .filter((line) => line.msg === SSH_HANDOVER_RECORD);
  assert.deepEqual(
    handed.map(({ binding_id, credential_id, execution_id }) => ({
      binding_id,
      credential_id,
      execution_id,
    })),
    expected.map(({ binding_id, credential_id }) => ({
      binding_id,
      credential_id,
      execution_id: f.row.execution_id,
    })),
  );
  assert.equal(f.logs.join("").includes(OPENSSH_LABEL), false);
  assert.throws(
    () =>
      openEnvelope(
        f.keys.handover,
        handoverAad(createIdentity("execution"), f.row.runtime_identity),
        f.handover(),
      ),
    HandoverOpenError,
  );
});

test("a pinned execution keeps its SSH key after a rotation and an unpinned execution takes the new key", (t) => {
  const f = fixture(t, ["anthro-1"], ["deploy"]);
  const open = () =>
    handoverPayloadSchema.parse(
      openEnvelope(f.keys.handover, f.aad, f.handover()),
    ).ssh_identities[0]!;
  const first = open();
  const firstKey = f.sshKeys.get("deploy")!;
  assert.equal(first.private_key, firstKey);
  f.rotateSsh("deploy");
  const pinned = open();
  assert.equal(pinned.credential_id, first.credential_id);
  assert.equal(pinned.private_key, firstKey);
  f.row.credentials.length = 0;
  const next = open();
  assert.notEqual(next.credential_id, first.credential_id);
  assert.equal(next.private_key, f.sshKeys.get("deploy"));
  assert.notEqual(next.private_key, firstKey);
});

test("a handover of a revoked pinned SSH revision answers revision_revoked and seals no envelope", (t) => {
  const f = fixture(t, ["anthro-1"], ["deploy"]);
  f.handover();
  const pinned = liveRevisionId(f.store, "deploy");
  f.rotateSsh("deploy");
  f.store.transaction((tx) =>
    f.component.revoke(tx, TEST_SET, "deploy", FIRST_SSH_REVISION),
  );
  const handed = () =>
    f.logs.filter((line) => JSON.parse(line).msg === SSH_HANDOVER_RECORD)
      .length;
  const before = handed();
  let envelope: ReturnType<typeof f.handover> | undefined;
  assert.throws(
    () => {
      envelope = f.handover();
    },
    (error) => {
      assert(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.Conflict);
      assert.equal(error.code, REVISION_REVOKED);
      return true;
    },
  );
  assert.equal(envelope, undefined);
  assert.equal(handed(), before);
  assert.ok(f.row.credentials.includes(pinned));
});

test("an SSH identity refusal seals no envelope and a legacy key answers ssh_key_legacy", (t) => {
  const f = fixture(t, ["anthro-1"], ["deploy"]);
  assert.throws(() => f.handover([createIdentity("binding")]), {
    code: "project.authorization.refused",
  });
  f.store.transaction((tx) =>
    f.component.rotateGenerated(
      tx,
      TEST_SET,
      "deploy",
      {
        expected_revision: 1,
        generate: () => ({
          secret: {
            private_key: `-----BEGIN ${OPENSSH_LABEL}-----\nbGVnYWN5\n-----END ${OPENSSH_LABEL}-----\n`,
          },
          metadata: { public_key: "legacy" },
        }),
      },
      undefined,
    ),
  );
  assert.throws(
    () => f.handover(),
    (error) => {
      assert(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.Conflict);
      assert.equal(error.code, RepositoryErrorCode.SshKeyLegacy);
      assert.equal(JSON.stringify(error).includes("bGVnYWN5"), false);
      return true;
    },
  );
});

test("a refresh report that carries an SSH key answers report_invalid", (t) => {
  const f = fixture(t, ["anthro-1"], ["deploy"]);
  f.handover();
  assert.throws(
    () =>
      f.report(
        sealEnvelope(f.keys.report, f.aad, {
          ...f.refresh,
          credential: {
            type: SecretShape.SshKey,
            private_key: f.sshKeys.get("deploy"),
          },
        }),
      ),
    (error) => {
      assert(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.BadRequest);
      assert.equal(error.code, CUSTODY_REPORT_INVALID);
      return true;
    },
  );
  const pinned = liveRevisionId(f.store, "deploy");
  assert.ok(f.row.credentials.includes(pinned));
  assert.throws(
    () =>
      f.report(
        sealEnvelope(f.keys.report, f.aad, {
          ...f.refresh,
          credential_id: pinned,
        }),
      ),
    (error) => {
      assert(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.BadRequest);
      assert.equal(error.code, CUSTODY_REPORT_INVALID);
      assert.equal(JSON.stringify(error).includes(OPENSSH_LABEL), false);
      return true;
    },
  );
  assert.equal(
    handoverPayloadSchema.parse(
      openEnvelope(f.keys.handover, f.aad, f.handover()),
    ).ssh_identities[0]?.private_key,
    f.sshKeys.get("deploy"),
  );
});

function signRequest(
  f: ReturnType<typeof fixture>,
  bindingId: string,
  credential: string,
  hostKey: Buffer | null = knownHostsKeyBlob(KNOWN_HOSTS),
) {
  const publicKey = sshPublicKeyOf(f.sshKeys.get(credential)!);
  const data = userAuthenticationData({
    key: sshPublicKeyBlob(publicKey),
    hostKey,
  });
  return {
    publicKey,
    data,
    request: {
      binding_id: bindingId,
      data: data.toString("base64"),
      flags: RSA_SHA2_512,
    },
  };
}

test("sshSign signs for a binding of the node, pins the revision at first use and logs no key", (t) => {
  const f = fixture(t, ["anthro-1"], ["deploy"]);
  const [bindingId] = [...f.bindings.keys()];
  const { publicKey, data, request } = signRequest(f, bindingId!, "deploy");
  const answer = sshSignAnswerSchema.parse(
    openEnvelope(f.signKeys.answer, f.aad, f.sign(request)),
  );
  assert.ok(
    sshSignatureVerifies(
      publicKey,
      data,
      Buffer.from(answer.signature, "base64"),
    ),
  );
  const pinned = liveRevisionId(f.store, "deploy");
  assert.deepEqual(f.row.credentials, [pinned]);
  const records = f.logs
    .map((line) => JSON.parse(line))
    .filter((line) => line.msg === SSH_SIGN_RECORD);
  assert.deepEqual(
    records.map(({ execution_id, binding_id, credential_id, client_id }) => ({
      execution_id,
      binding_id,
      credential_id,
      client_id,
    })),
    [
      {
        execution_id: f.row.execution_id,
        binding_id: bindingId,
        credential_id: pinned,
        client_id: f.identity.clientId,
      },
    ],
  );
  assert.ok(Object.hasOwn(records[0]!, "instance_id"));
  assert.equal(f.logs.join("").includes(OPENSSH_LABEL), false);
  f.rotateSsh("deploy");
  const again = signRequest(f, bindingId!, "deploy");
  assert.throws(() => f.sign(again.request), {
    code: SshSignErrorCode.Refused,
  });
});

test("sshSign refuses another binding, no live claim, an invalid envelope and a refused payload", (t) => {
  const f = fixture(t, ["anthro-1"], ["deploy"]);
  const [bindingId] = [...f.bindings.keys()];
  const { request } = signRequest(f, bindingId!, "deploy");
  assert.throws(
    () => f.sign({ ...request, binding_id: createIdentity("binding") }),
    { code: "project.authorization.refused" },
  );
  assert.throws(() => f.sign({ ...request, flags: -1 }), {
    code: SSH_SIGN_INVALID,
  });
  assert.throws(
    () =>
      f.store.transaction((tx) =>
        f.component.sshSign(
          tx,
          f.identity,
          f.claim,
          sealEnvelope(f.keys.report, f.aad, request),
          NOW,
        ),
      ),
    { code: SSH_SIGN_INVALID },
  );
  f.setRunning(false);
  assert.throws(() => f.sign(request), {
    code: "scheduler.execution.not_running",
  });
  assert.deepEqual(f.row.credentials, []);
  assert.equal(
    f.logs.some((line) => JSON.parse(line).msg === SSH_SIGN_RECORD),
    false,
  );
  f.setRunning(true);
  const other = signRequest(f, bindingId!, "deploy", Buffer.from("other"));
  assert.throws(
    () => f.sign(other.request),
    (error) => {
      assert(error instanceof OperationError);
      assert.equal(error.code, SshSignErrorCode.Refused);
      assert.deepEqual(error.details, {
        reason: SshSignRefusal.HostKeyMismatch,
      });
      return true;
    },
  );
});

test("sshPublicKeyOf answers the pinned revision, else the newest live revision, and pins nothing", (t) => {
  const f = fixture(t, ["anthro-1"], ["deploy"]);
  const [bindingId] = [...f.bindings.keys()];
  const first = sshPublicKeyOf(f.sshKeys.get("deploy")!);
  assert.equal(f.publicKeyOf("deploy"), first);
  assert.deepEqual(f.row.credentials, []);
  f.sign(signRequest(f, bindingId!, "deploy").request);
  f.rotateSsh("deploy");
  assert.equal(f.publicKeyOf("deploy"), first);
  f.store.transaction((tx) =>
    f.component.revoke(tx, TEST_SET, "deploy", FIRST_SSH_REVISION),
  );
  assert.throws(() => f.publicKeyOf("deploy"), { code: REVISION_REVOKED });
  f.row.credentials.length = 0;
  assert.equal(
    f.publicKeyOf("deploy"),
    sshPublicKeyOf(f.sshKeys.get("deploy")!),
  );
  f.store.database
    .prepare("UPDATE credential SET metadata = NULL WHERE name = ?")
    .run("deploy");
  assert.equal(f.publicKeyOf("deploy"), null);
});
