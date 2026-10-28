import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { z } from "zod";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";
import { PROJECT_SERVICE_NAME } from "../project/contract.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  testHumanIdentity,
  testMachineIdentity,
} from "../kernel/test-identity.ts";
import {
  type CredentialPlatformSet,
  CUSTODY_SERVICE_NAME,
  type CustodyExecution,
  GrantKind,
  SecretShape,
  type SshIdentityAuthorization,
  type SshIdentitySubject,
  SshIdentitySubjectKind,
} from "./contract.ts";
import { custodyMigrations } from "./migrations.ts";
import { CustodyComponent } from "./service.ts";
import {
  consumeGrant,
  FacilityError,
  grantFacts,
  MaterialBuffer,
  mintGrant,
} from "./facility.ts";

const FIELDS = {
  kind: GrantKind.ModelInference,
  credential: "anthro-1",
  platform: "anthropic",
  project_id: "project-one",
  execution: {
    execution_id: "execution-one",
    project_id: "project-one",
    worker_binding_id: "binding-one",
    resource_identity: "worker:kanthord:general",
    runtime_identity: "runtime-one",
    credentials: [] as string[],
  },
  facts: { provider_id: "anthropic", agent_provider: "default" },
};
const SECRET = { key: "private-material" };

test("grants freeze a snapshot and reject fabrication, copies and repeated consumption", () => {
  const grant = mintGrant(FIELDS);
  assert(Object.isFrozen(grant));
  assert(Object.isFrozen(grant.execution!.credentials));
  assert(Object.isFrozen(grant.facts));
  assert.notEqual(grant.execution, FIELDS.execution);
  assert.notEqual(grant.facts, FIELDS.facts);
  assert.throws(() => consumeGrant(FIELDS), FacilityError);
  assert.throws(() => consumeGrant(Object.freeze({ ...grant })), FacilityError);
  consumeGrant(grant);
  assert.throws(() => consumeGrant(grant), FacilityError);
});

test("grant facts answer the project, the credential and frozen facts without consumption", () => {
  const fields = {
    ...FIELDS,
    kind: GrantKind.RequestEvidence,
    credential: null,
    execution: null,
    facts: { nested: { values: ["one"] } },
  } as unknown as Parameters<
    typeof mintGrant<typeof GrantKind.RequestEvidence>
  >[0];
  const grant = mintGrant(fields);
  const answer = grantFacts(grant);
  assert.deepEqual(answer, {
    project_id: "project-one",
    credential: null,
    facts: { nested: { values: ["one"] } },
  });
  assert(Object.isFrozen(answer));
  assert(
    Object.isFrozen((answer.facts as unknown as { nested: object }).nested),
  );
  assert.deepEqual(grantFacts(grant), answer);
  consumeGrant(grant);
  assert.deepEqual(grantFacts(grant), answer);
  assert.throws(() => grantFacts(Object.freeze({ ...grant })), FacilityError);
});

test("material clears its owned bytes on success and holder failure", (t) => {
  const fill = Buffer.prototype.fill;
  const cleared: Buffer[] = [];
  t.mock.method(
    Buffer.prototype,
    "fill",
    function (this: Buffer, ...args: Parameters<typeof fill>) {
      const result = Reflect.apply(fill, this, args);
      cleared.push(this);
      return result;
    },
  );
  for (const fail of [false, true]) {
    const material = new MaterialBuffer("credential-one", "anthropic", SECRET);
    const holder = () => {
      try {
        assert.deepEqual(material.value(), SECRET);
        assert.equal(JSON.stringify(material).includes(SECRET.key), false);
        if (fail) throw new Error("holder failed");
      } finally {
        material.drop();
      }
    };
    if (fail) assert.throws(holder);
    else holder();
    assert.throws(() => material.value(), FacilityError);
    material.drop();
  }
  assert(cleared.length);
  for (const bytes of cleared)
    assert.deepEqual(bytes, Buffer.alloc(bytes.length));
});

const SSH_PLATFORM = "ssh-test";
const KEY_PLATFORM = "key-test";
const SSH_CREDENTIAL = "deploy";
const KEY_CREDENTIAL = "token";
const SSH_ADDRESS = "git@github.com:owner/repository.git";
const OPENSSH_LABEL = "OPENSSH PRIVATE KEY";
const FIRST_KEY_BODY = "Zmlyc3Qta2V5";
const SECOND_KEY_BODY = "c2Vjb25kLWtleQ==";
const FIRST_REVISION = 1;
const ONE_CALL = 1;
const NOW = 1000;
const SSH_SET: CredentialPlatformSet = {
  platforms: {
    [SSH_PLATFORM]: {
      secret_shape: SecretShape.SshKey,
      login_modes: [],
      metadata_schema: z.strictObject({ public_key: z.string() }),
      capability: "ssh identity",
      probe: null,
    },
    [KEY_PLATFORM]: {
      secret_shape: SecretShape.ApiKey,
      login_modes: [],
      metadata_schema: null,
      capability: "none",
      probe: null,
    },
  },
};

function sshSecret(body: string) {
  return {
    private_key: `-----BEGIN ${OPENSSH_LABEL}-----\n${body}\n-----END ${OPENSSH_LABEL}-----\n`,
  };
}

function sshFixture(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  const row: CustodyExecution = {
    execution_id: createIdentity("execution"),
    project_id: createIdentity("project"),
    worker_binding_id: createIdentity("binding"),
    resource_identity: "worker:kanthord:general",
    runtime_identity: createIdentity("worker_registration"),
    credentials: [],
  };
  const claim: ExecutionClaim = {
    executionId: row.execution_id,
    projectId: row.project_id,
    nodeId: createIdentity("node"),
    attempt: FIRST_REVISION,
    pinnedRevision: FIRST_REVISION,
    nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    runtimeIdentity: row.runtime_identity,
    workerBindingId: row.worker_binding_id,
  };
  const machine = testMachineIdentity(
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
  const human = testHumanIdentity("alice", "Alice", "jti");
  const calls: {
    identity: CallerIdentity;
    subject: SshIdentitySubject;
    claim: ExecutionClaim | null;
  }[] = [];
  const answer = { credential: SSH_CREDENTIAL, platform: SSH_PLATFORM };
  const port: SshIdentityAuthorization = {
    sshIdentity: (tx, identity, subject, received) => {
      assert.ok(tx.database.isTransaction);
      calls.push({ identity, subject, claim: received });
      return {
        ...answer,
        project_id: row.project_id,
        facts: { binding_id: "binding_one", address: SSH_ADDRESS },
      };
    },
  };
  const unexpected = () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  };
  const build = (sshIdentityAuthorization?: SshIdentityAuthorization) =>
    new CustodyComponent({
      executions: {
        requireRunning: (_tx, executionId, runtimeIdentity) => {
          assert.equal(executionId, row.execution_id);
          assert.equal(runtimeIdentity, row.runtime_identity);
          return row;
        },
        pinCredential: (_tx, _executionId, credentialId) => {
          row.credentials.push(credentialId);
        },
        liveExecutionsPinning: (_tx, credentialId) =>
          row.credentials.includes(credentialId) ? [row.execution_id] : [],
      },
      authorization: { authorizeModelInference: unexpected },
      missionAuthorization: {
        frozenAction: unexpected,
        serviceMerge: unexpected,
        requestEvidence: unexpected,
        evidenceAsset: unexpected,
        objectPut: unexpected,
      },
      clientSecret: () => Buffer.alloc(32, 9).toString("base64"),
      store,
      platforms: SSH_SET.platforms,
      envelopeKey: Buffer.alloc(32, 7),
      logger: pino({ enabled: false }),
      agentProvidersDependentOn: () => [],
      bindingsNaming: () => [],
      inboundsNaming: () => [],
      intakeServiceName: INTAKE_SERVICE_NAME,
      projectServiceName: PROJECT_SERVICE_NAME,
      ...(sshIdentityAuthorization === undefined
        ? {}
        : { sshIdentityAuthorization }),
    });
  const custody = build(port);
  store.transaction((tx) => {
    custody.createGenerated(
      tx,
      SSH_SET,
      {
        name: SSH_CREDENTIAL,
        platform: SSH_PLATFORM,
        generate: () => ({
          secret: sshSecret(FIRST_KEY_BODY),
          metadata: { public_key: "first" },
        }),
      },
      "alice",
    );
    custody.create(
      tx,
      SSH_SET,
      {
        name: KEY_CREDENTIAL,
        platform: KEY_PLATFORM,
        metadata: null,
        secret: { key: "token-value" },
      },
      "alice",
    );
  });
  const rotate = () =>
    store.transaction((tx) =>
      custody.rotateGenerated(
        tx,
        SSH_SET,
        SSH_CREDENTIAL,
        {
          expected_revision: FIRST_REVISION,
          generate: () => ({
            secret: sshSecret(SECOND_KEY_BODY),
            metadata: { public_key: "second" },
          }),
        },
        "alice",
      ),
    );
  const binding: SshIdentitySubject = {
    kind: SshIdentitySubjectKind.Binding,
    binding_id: "binding_one",
  };
  const draft: SshIdentitySubject = {
    kind: SshIdentitySubjectKind.Draft,
    project_id: row.project_id,
    credential: SSH_CREDENTIAL,
    address: SSH_ADDRESS,
  };
  const grant = (
    identity: CallerIdentity,
    subject: SshIdentitySubject,
    received: ExecutionClaim | null,
    component = custody,
  ) =>
    store.transaction((tx) =>
      component.authorizeOperation(
        tx,
        { kind: GrantKind.SshIdentity, identity, subject, claim: received },
        NOW,
      ),
    );
  const released = (value: ReturnType<typeof grant>) =>
    store.transaction((tx) => {
      const material = custody.release(tx, value, NOW);
      try {
        return {
          id: material.credential_id,
          value: material.value(),
        };
      } finally {
        material.drop();
      }
    });
  return {
    row,
    claim,
    machine,
    human,
    calls,
    answer,
    build,
    rotate,
    binding,
    draft,
    grant,
    released,
  };
}

test("an ssh_identity grant of a human releases the newest live key and pins nothing", (t) => {
  const f = sshFixture(t);
  const granted = f.grant(f.human, f.draft, null);
  assert.equal(granted.kind, GrantKind.SshIdentity);
  assert.equal(granted.execution, null);
  assert.deepEqual(f.calls, [
    { identity: f.human, subject: f.draft, claim: null },
  ]);
  f.rotate();
  const material = f.released(granted);
  assert.deepEqual(material.value, sshSecret(SECOND_KEY_BODY));
  assert.deepEqual(f.row.credentials, []);
});

test("an ssh_identity grant of a machine with a proven claim pins the revision at first use", (t) => {
  const f = sshFixture(t);
  const first = f.released(f.grant(f.machine, f.binding, f.claim));
  assert.deepEqual(first.value, sshSecret(FIRST_KEY_BODY));
  assert.deepEqual(f.row.credentials, [first.id]);
  f.rotate();
  const pinned = f.released(f.grant(f.machine, f.binding, f.claim));
  assert.equal(pinned.id, first.id);
  assert.deepEqual(pinned.value, sshSecret(FIRST_KEY_BODY));
  assert.deepEqual(f.calls.at(-1), {
    identity: f.machine,
    subject: f.binding,
    claim: f.claim,
  });
});

test("an ssh_identity grant refuses a machine without a claim, a claim without a machine, no port and another platform", (t) => {
  const f = sshFixture(t);
  assert.throws(() => f.grant(f.machine, f.binding, null), FacilityError);
  assert.throws(() => f.grant(f.human, f.binding, f.claim), FacilityError);
  assert.throws(
    () => f.grant(f.human, f.draft, null, f.build()),
    FacilityError,
  );
  f.answer.platform = KEY_PLATFORM;
  f.answer.credential = KEY_CREDENTIAL;
  assert.throws(() => f.grant(f.human, f.draft, null), FacilityError);
  assert.equal(f.calls.length, ONE_CALL);
  assert.deepEqual(f.row.credentials, []);
});

test("an ssh_identity grant refuses a draft subject of a machine before the port", (t) => {
  const f = sshFixture(t);
  assert.throws(() => f.grant(f.machine, f.draft, f.claim), FacilityError);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.row.credentials, []);
});

test("an ssh_identity release refuses a fabricated grant and a consumed grant", (t) => {
  const f = sshFixture(t);
  const granted = f.grant(f.human, f.draft, null);
  assert.throws(() => f.released(Object.freeze({ ...granted })), FacilityError);
  f.released(granted);
  assert.throws(() => f.released(granted), FacilityError);
});
