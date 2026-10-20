import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  GrantKind,
  SshIdentitySubjectKind,
  type SshIdentitySubject,
} from "../../custody/contract.ts";
import { grantFacts } from "../../custody/index.ts";
import type { CallerIdentity } from "../../kernel/caller.ts";
import { OperationError } from "../../kernel/errors.ts";
import { ResourceStatus } from "../../kernel/health.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import {
  MISSION_SERVICE_NAME,
  MissionErrorCode,
} from "../../mission/contract.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import {
  PROJECT_SERVICE_NAME,
  ProjectErrorCode,
  RESOURCE_CAPABILITY_NETWORK_GIT_READ,
  SSH_CREDENTIAL_PLATFORM,
  projectOperations,
} from "../../project/contract.ts";
import { projectSshIdentityAuthorization } from "../../project/index.ts";
import type { SshAccess } from "../../repository/index.ts";
import {
  FAKE_GITHUB_HOST_KEY,
  FAKE_SSH_HOST,
  gatewayFixture,
  humanCaller,
  provisionRepositoryCredentials,
} from "./test-support.ts";

const ADDRESS = "git@github.com:owner/repo.git";
const PROJECT_NAME = "ssh-release";
const REPOSITORY_NAME = "repo";
const SSH_CREDENTIAL = "github-ssh";
const FIRST_BINDING_SET_VERSION = 1;
const SINGLE_READ = 1;
const FACILITY_REFUSAL = { name: "FacilityError" };
const EVIDENCE_ID = "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OPENSSH_ARMOR = "-----BEGIN OPENSSH PRIVATE KEY-----";

async function setup(t: TestContext) {
  const reads: Array<{ address: string; ssh: SshAccess }> = [];
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async (address, _context, _deadlineMs, ssh) =>
        void reads.push({ address, ssh }),
    },
  });
  await provisionRepositoryCredentials(fixture);
  const call = humanCaller(fixture);
  const project = await call(projectOperations.create, {
    params: {},
    query: {},
    body: { name: PROJECT_NAME },
  });
  const written = await call(projectOperations["bindingSet.write"], {
    params: { project_id: project.id },
    query: {},
    body: {
      version: FIRST_BINDING_SET_VERSION,
      bindings: {
        [REPOSITORY_NAME]: {
          kind: "repository",
          config: {
            available: true,
            platform: "github",
            address: ADDRESS,
            ssh_credential: SSH_CREDENTIAL,
            strategy: { base_branch: "main" },
          },
        },
      },
    },
  });
  const binding = written.bindings[REPOSITORY_NAME];
  assert.ok(binding);
  const release = (identity: CallerIdentity, subject: SshIdentitySubject) =>
    fixture.store.transaction((tx) => {
      const now = Date.now();
      const grant = fixture.custody.authorizeOperation(
        tx,
        { kind: GrantKind.SshIdentity, identity, subject, claim: null },
        now,
      );
      const facts = grantFacts(grant);
      const material = fixture.custody.release(tx, grant, now);
      try {
        return { facts, value: material.value() };
      } finally {
        material.drop();
      }
    });
  return {
    fixture,
    reads,
    project,
    binding,
    written,
    release,
    subject: {
      kind: SshIdentitySubjectKind.Binding,
      binding_id: binding.id,
    } as const,
  };
}

function projectRefusal(reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, HttpStatus.Forbidden);
    assert.equal(error.code, ProjectErrorCode.AuthorizationRefused);
    assert.deepEqual(error.details, { reason });
    return true;
  };
}

test("the service identity of the Project Service releases the key of a live repository binding", async (t) => {
  const f = await setup(t);
  const { facts, value } = f.release(
    mintServiceIdentity(PROJECT_SERVICE_NAME),
    f.subject,
  );
  assert.deepEqual(facts, {
    project_id: f.project.id,
    credential: SSH_CREDENTIAL,
    facts: { binding_id: f.binding.id, address: ADDRESS },
  });
  assert.ok(
    (value as { private_key: string }).private_key.startsWith(OPENSSH_ARMOR),
  );
});

test("the service identity of the Project Service refuses a draft and a removed binding", async (t) => {
  const f = await setup(t);
  const identity = mintServiceIdentity(PROJECT_SERVICE_NAME);
  assert.throws(
    () =>
      f.release(identity, {
        kind: SshIdentitySubjectKind.Draft,
        project_id: f.project.id,
        credential: SSH_CREDENTIAL,
        address: ADDRESS,
      }),
    FACILITY_REFUSAL,
  );
  await humanCaller(f.fixture)(projectOperations["bindingSet.write"], {
    params: { project_id: f.project.id },
    query: {},
    body: { version: f.written.binding_set_version, bindings: {} },
  });
  assert.throws(
    () => f.release(identity, f.subject),
    projectRefusal("binding_not_found"),
  );
});

test("the service identity of another service refuses the key of a repository binding", async (t) => {
  const f = await setup(t);
  assert.throws(
    () => f.release(mintServiceIdentity(MISSION_SERVICE_NAME), f.subject),
    projectRefusal("identity_refused"),
  );
});

function evidencePort(bindingId: string) {
  const reads: string[] = [];
  const port = projectSshIdentityAuthorization({
    custodySuitability: () => assert.fail("A request evidence names no draft."),
    repositoryBindingIdsOf: () => [],
    requestEvidenceBindingOf: (tx, identity, evidenceId) => {
      assert.ok(tx.database.isTransaction);
      assert.equal(identity.service, MISSION_SERVICE_NAME);
      reads.push(evidenceId);
      return bindingId;
    },
  });
  return { port, reads };
}

test("the service identity of the Mission Service passes for a request evidence through the binding of its frozen action", async (t) => {
  const f = await setup(t);
  const { port, reads } = evidencePort(f.binding.id);
  const evidence = {
    kind: SshIdentitySubjectKind.RequestEvidence,
    evidence_id: EVIDENCE_ID,
  } as const;
  const authorize = (identity: CallerIdentity) =>
    f.fixture.store.transaction((tx) =>
      port.sshIdentity(tx, identity, evidence, null),
    );
  assert.deepEqual(authorize(mintServiceIdentity(MISSION_SERVICE_NAME)), {
    credential: SSH_CREDENTIAL,
    platform: SSH_CREDENTIAL_PLATFORM,
    project_id: f.project.id,
    facts: { binding_id: f.binding.id, address: ADDRESS },
  });
  assert.deepEqual(reads, [EVIDENCE_ID]);
  assert.throws(
    () => authorize(mintServiceIdentity(PROJECT_SERVICE_NAME)),
    projectRefusal("identity_refused"),
  );
  assert.deepEqual(reads, [EVIDENCE_ID]);
  await humanCaller(f.fixture)(projectOperations["bindingSet.write"], {
    params: { project_id: f.project.id },
    query: {},
    body: { version: f.written.binding_set_version, bindings: {} },
  });
  assert.throws(
    () => authorize(mintServiceIdentity(MISSION_SERVICE_NAME)),
    projectRefusal("binding_not_found"),
  );
});

test("the service identity of the Mission Service refuses the key of an absent request evidence", async (t) => {
  const f = await setup(t);
  assert.throws(
    () =>
      f.release(mintServiceIdentity(MISSION_SERVICE_NAME), {
        kind: SshIdentitySubjectKind.RequestEvidence,
        evidence_id: EVIDENCE_ID,
      }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, MissionErrorCode.AuthorizationRefused);
      assert.deepEqual(error.details, { reason: "node_mismatch" });
      return true;
    },
  );
});

test("the resource healthcheck reads the repository with the key that the Project identity releases", async (t) => {
  const f = await setup(t);
  f.reads.length = 0;
  const response = await f.fixture.request(gatewayOperations.healthcheck.path, {
    headers: { Authorization: `Bearer ${f.fixture.token}` },
  });
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.healthcheck.output.parse(
    await response.json(),
  );
  assert.deepEqual(body.services.project.projects[PROJECT_NAME], {
    [REPOSITORY_NAME]: {
      status: ResourceStatus.Healthy,
      capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
      failure_reason: null,
    },
  });
  assert.equal(f.reads.length, SINGLE_READ);
  assert.equal(f.reads[0]?.address, ADDRESS);
  const read = f.reads[0]?.ssh;
  assert.ok(read && "private_key" in read);
  assert.ok(read.private_key.startsWith(OPENSSH_ARMOR));
  assert.equal(
    f.reads[0]?.ssh.known_hosts,
    `${FAKE_SSH_HOST} ${FAKE_GITHUB_HOST_KEY}\n`,
  );
});
