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
  handoverAad,
  openEnvelope,
  sealEnvelope,
  HandoverOpenError,
} from "../kernel/handover.ts";
import { redactionPaths } from "../kernel/log.ts";
import { custodyMigrations } from "./migrations.ts";
import { CustodyComponent } from "./service.ts";
import { CUSTODY_REPORT_INVALID, REVISION_REVOKED } from "./handover.ts";
import {
  CUSTODY_SERVICE_NAME,
  handoverPayloadSchema,
  SecretShape,
  SshIdentitySubjectKind,
  type CredentialPlatformSet,
  type CustodyExecution,
  type SshIdentityAuthorization,
} from "./contract.ts";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import { RepositoryComponent } from "../repository/index.ts";
import { generateSshKey } from "../repository/ssh-key.ts";
import { RepositoryErrorCode } from "../repository/contract.ts";

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
    runtime_identity: createIdentity("worker_instance"),
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
  const handover = (bindingIds: readonly string[] = [...bindings.keys()]) =>
    store.transaction((tx) =>
      component.handover(tx, identity, claim, bindingIds, NOW),
    );
  const report = (envelope: ReturnType<typeof sealEnvelope>) =>
    store.transaction((tx) =>
      component.report(tx, identity, claim, envelope, NOW),
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
    credentialId,
    credentialIds,
    keys,
    aad,
    handover,
    report,
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
});
