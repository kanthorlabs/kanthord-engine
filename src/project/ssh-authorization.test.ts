import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  SshIdentitySubjectKind,
  type SshIdentitySubject,
} from "../custody/contract.ts";
import { IdentityKind, type CallerIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  testHumanIdentity,
  testMachineIdentity,
} from "../kernel/test-identity.ts";
import {
  BindingKind,
  PROJECT_ID_PREFIX,
  PROJECT_SERVICE_NAME,
  ProjectErrorCode,
  REPOSITORY_PLATFORM,
  SSH_CREDENTIAL_PLATFORM,
} from "./contract.ts";
import { projectMigrations } from "./migrations.ts";
import { projectSshIdentityAuthorization } from "./ssh-authorization.ts";
import {
  insertProject,
  readCurrentBindingByName,
  writeBindingSet,
} from "./store.ts";

const ADDRESS = "git@github.com:owner/repo.git";
const SSH_CREDENTIAL = "deploy";
const OTHER_CREDENTIAL = "other";
const REPOSITORY_NAME = "repo";
const WORKER_NAME = "worker";
const NODE_REVISION = 3;
const OTHER_NODE_REVISION = 4;
const RUNTIME_IDENTITY = "runtime";

function repository() {
  return {
    kind: BindingKind.Repository,
    config: {
      available: true,
      platform: REPOSITORY_PLATFORM,
      address: ADDRESS,
      ssh_credential: SSH_CREDENTIAL,
      strategy: { base_branch: "main" },
    },
  };
}

function worker() {
  return {
    kind: BindingKind.Worker,
    config: { worker: "coder@1", instance_count: 1 },
  };
}

function revisionKey(nodeId: string, revision: number): string {
  return JSON.stringify([nodeId, revision]);
}

function setup(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
  ]);
  const saved = store.transaction((tx) => {
    const project = insertProject(tx, "alpha");
    const result = writeBindingSet(
      tx,
      project.id,
      project.binding_set_version,
      new Map<string, ReturnType<typeof repository | typeof worker>>([
        [REPOSITORY_NAME, repository()],
        [WORKER_NAME, worker()],
      ]),
    );
    const repositoryId = readCurrentBindingByName(
      tx,
      project.id,
      REPOSITORY_NAME,
    )?.id;
    const workerId = readCurrentBindingByName(tx, project.id, WORKER_NAME)?.id;
    assert.ok(repositoryId && workerId);
    return {
      project_id: project.id,
      binding_id: repositoryId,
      worker_binding_id: workerId,
      version: result.newVersion,
    };
  });
  const suitability: Array<{ credential: string; platform: string }> = [];
  const pinned = new Map<string, string[]>();
  const port = projectSshIdentityAuthorization({
    custodySuitability: (tx, request) => {
      assert.ok(tx.database.isTransaction);
      suitability.push(request);
    },
    repositoryBindingIdsOf: (tx, nodeId, revision) => {
      assert.ok(tx.database.isTransaction);
      return pinned.get(revisionKey(nodeId, revision)) ?? [];
    },
  });
  const nodeId = createIdentity("node");
  pinned.set(revisionKey(nodeId, NODE_REVISION), [saved.binding_id]);
  const claim: ExecutionClaim = {
    executionId: createIdentity("execution"),
    projectId: saved.project_id,
    nodeId,
    attempt: 1,
    pinnedRevision: NODE_REVISION,
    nodeBranch: `kanthord/${nodeId}`,
    runtimeIdentity: RUNTIME_IDENTITY,
    workerBindingId: saved.worker_binding_id,
  };
  const machine = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      projectId: saved.project_id,
      resourceIdentity: "worker:kanthord:worker",
      name: "machine",
      issuedAt: 0,
    },
    "jti",
    RUNTIME_IDENTITY,
  );
  const authorize = (
    identity: CallerIdentity,
    subject: SshIdentitySubject,
    received: ExecutionClaim | null = null,
  ) =>
    store.transaction((tx) =>
      port.sshIdentity(tx, identity, subject, received),
    );
  return {
    store,
    saved,
    suitability,
    claim,
    machine,
    authorize,
    binding: {
      kind: SshIdentitySubjectKind.Binding,
      binding_id: saved.binding_id,
    } as const,
  };
}

const human = () => testHumanIdentity("alice", "Alice", "jti");

function refused(reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, HttpStatus.Forbidden);
    assert.equal(error.code, ProjectErrorCode.AuthorizationRefused);
    assert.deepEqual(error.details, { reason });
    return true;
  };
}

test("a human passes for a repository binding and receives its credential and address", (t) => {
  const f = setup(t);
  assert.deepEqual(f.authorize(human(), f.binding), {
    credential: SSH_CREDENTIAL,
    platform: SSH_CREDENTIAL_PLATFORM,
    project_id: f.saved.project_id,
    facts: { binding_id: f.saved.binding_id, address: ADDRESS },
  });
});

test("a human passes for a draft configuration after the custody suitability of its credential", (t) => {
  const f = setup(t);
  const draft = {
    kind: SshIdentitySubjectKind.Draft,
    project_id: f.saved.project_id,
    credential: OTHER_CREDENTIAL,
    address: ADDRESS,
  } as const;
  assert.deepEqual(f.authorize(human(), draft), {
    credential: OTHER_CREDENTIAL,
    platform: SSH_CREDENTIAL_PLATFORM,
    project_id: f.saved.project_id,
    facts: { binding_id: null, address: ADDRESS },
  });
  assert.deepEqual(f.suitability, [
    { credential: OTHER_CREDENTIAL, platform: SSH_CREDENTIAL_PLATFORM },
  ]);
});

test("a draft configuration refuses an absent project", (t) => {
  const f = setup(t);
  assert.throws(
    () =>
      f.authorize(human(), {
        kind: SshIdentitySubjectKind.Draft,
        project_id: createIdentity(PROJECT_ID_PREFIX),
        credential: SSH_CREDENTIAL,
        address: ADDRESS,
      }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, ProjectErrorCode.ProjectNotFound);
      return true;
    },
  );
});

test("a service identity without provenance refuses a binding", (t) => {
  const f = setup(t);
  assert.throws(
    () =>
      f.authorize(
        { kind: IdentityKind.Service, service: PROJECT_SERVICE_NAME },
        f.binding,
      ),
    refused("identity_refused"),
  );
});

test("a machine with a proven claim passes only for a repository binding of the pinned node revision", (t) => {
  const f = setup(t);
  assert.equal(
    f.authorize(f.machine, f.binding, f.claim).facts.binding_id,
    f.saved.binding_id,
  );
  assert.throws(
    () =>
      f.authorize(f.machine, f.binding, {
        ...f.claim,
        nodeId: createIdentity("node"),
      }),
    refused("node_mismatch"),
  );
  assert.throws(
    () =>
      f.authorize(f.machine, f.binding, {
        ...f.claim,
        projectId: createIdentity(PROJECT_ID_PREFIX),
      }),
    refused("node_mismatch"),
  );
  assert.throws(
    () =>
      f.authorize(f.machine, f.binding, {
        ...f.claim,
        pinnedRevision: OTHER_NODE_REVISION,
      }),
    refused("node_mismatch"),
  );
});

test("a draft configuration refuses a machine and a service identity before the custody suitability", (t) => {
  const f = setup(t);
  const draft = {
    kind: SshIdentitySubjectKind.Draft,
    project_id: f.saved.project_id,
    credential: SSH_CREDENTIAL,
    address: ADDRESS,
  } as const;
  assert.throws(
    () => f.authorize(f.machine, draft, f.claim),
    refused("identity_refused"),
  );
  assert.throws(
    () =>
      f.authorize(
        { kind: IdentityKind.Service, service: PROJECT_SERVICE_NAME },
        draft,
      ),
    refused("identity_refused"),
  );
  assert.deepEqual(f.suitability, []);
});

test("a machine without a claim refuses a binding", (t) => {
  const f = setup(t);
  assert.throws(
    () => f.authorize(f.machine, f.binding),
    refused("identity_refused"),
  );
});

test("an absent binding, a worker binding and a removed binding refuse every identity", (t) => {
  const f = setup(t);
  assert.throws(
    () =>
      f.authorize(human(), {
        kind: SshIdentitySubjectKind.Binding,
        binding_id: createIdentity("binding"),
      }),
    refused("binding_not_found"),
  );
  assert.throws(
    () =>
      f.authorize(human(), {
        kind: SshIdentitySubjectKind.Binding,
        binding_id: f.saved.worker_binding_id,
      }),
    refused("binding_not_found"),
  );
  f.store.transaction((tx) =>
    writeBindingSet(tx, f.saved.project_id, f.saved.version, new Map()),
  );
  assert.throws(
    () => f.authorize(human(), f.binding),
    refused("binding_not_found"),
  );
});
