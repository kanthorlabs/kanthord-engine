import assert from "node:assert/strict";
import { test } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { HttpStatus } from "../kernel/http.ts";
import { authorizeModelInference } from "./authorization.ts";
import { getWorkerDeclaration } from "./catalog.ts";
import { TWO_AGENT_WORKER, twoAgentDeclarationOf } from "./test-support.ts";
import {
  AuthorizationRefusal,
  type WorkerBindingRowOf,
  WorkerErrorCode,
} from "./contract.ts";
import { AgentErrorCode, ChainLevel } from "../agent/contract.ts";
import type { AgentSelection } from "../scheduler/contract.ts";
import { stopAfter } from "../kernel/test-support.ts";

function pinOf(
  agentName: string,
  change: Partial<AgentSelection> = {},
): AgentSelection {
  return {
    agent_name: agentName,
    position: 0,
    level: ChainLevel.Enablement,
    agent_provider: "default",
    provider: "anthropic",
    credential: "anthro-1",
    model_identifier: "claude-sonnet-4-5",
    reasoning_effort: "off",
    ...change,
  };
}

test("Worker authorizes the pinned inference configuration and refuses each broken binding chain", (t) => {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  const row: NonNullable<ReturnType<WorkerBindingRowOf>> = {
    binding_id: createIdentity("binding"),
    project_id: createIdentity("project"),
    resource_identity: "worker:kanthord:worker",
    worker_name: "coder@1",
    entries: [],
    resource_budget: null,
    tombstone: false,
    disabled: false,
    worker_instances: [],
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      projectId: row.project_id,
      resourceIdentity: row.resource_identity,
      name: "test",
      issuedAt: 0,
    },
    "jti",
    createIdentity("worker_registration"),
  );
  const execution = {
    execution_id: createIdentity("execution"),
    project_id: row.project_id,
    worker_binding_id: row.binding_id,
    resource_identity: row.resource_identity,
  };
  let valid = true;
  let pinned = pinOf("swe@1");
  const issues = [{ path: ["agent"], code: AgentErrorCode.Unavailable }];
  const authorize = (change = {}) =>
    store.transaction((tx) =>
      authorizeModelInference(
        {
          workerBindingRowOf: (_tx, id) => (id === row.binding_id ? row : null),
          pinnedCredentialMetadata: () => null,
          credentialMetadata: () => null,
          schedulerClaims: { agentSelectionsOf: () => [pinned] },
        },
        {
          declarationOf: () => getWorkerDeclaration(row.worker_name) ?? null,
          pinnedAgentView: (_tx, worker, selection, models) => {
            assert.equal(worker, row.worker_name);
            assert.ok(models);
            assert.ok(
              getWorkerDeclaration(row.worker_name)?.agent_names?.includes(
                selection.agent_name,
              ),
            );
            return {
              valid,
              issues: valid ? [] : issues,
              effective: valid
                ? {
                    agent_provider: selection.agent_provider,
                    provider: selection.provider,
                    credential: selection.credential,
                    model_identifier: selection.model_identifier,
                    reasoning_effort: selection.reasoning_effort,
                  }
                : null,
            };
          },
        },
        tx,
        identity,
        { ...execution, ...change },
      ),
    );
  assert.deepEqual(authorize(), [
    {
      credential: "anthro-1",
      platform: "anthropic",
      provider_id: "anthropic",
      agent_provider: "default",
    },
  ]);
  pinned = pinOf("swe@1", {
    agent_provider: "override",
    credential: "anthro-2",
  });
  assert.deepEqual(authorize(), [
    {
      credential: "anthro-2",
      platform: "anthropic",
      provider_id: "anthropic",
      agent_provider: "override",
    },
  ]);
  for (const change of [
    { worker_binding_id: "absent" },
    { project_id: "other" },
    { resource_identity: "other" },
  ])
    assert.throws(() => authorize(change), {
      status: HttpStatus.Forbidden,
      code: WorkerErrorCode.AuthorizationRefused,
      details: { reason: AuthorizationRefusal.BindingMismatch },
    });
  row.disabled = true;
  assert.deepEqual(authorize(), [
    {
      credential: "anthro-2",
      platform: "anthropic",
      provider_id: "anthropic",
      agent_provider: "override",
    },
  ]);
  row.worker_name = "claude-code@1";
  assert.throws(authorize, {
    code: WorkerErrorCode.AuthorizationRefused,
    details: { reason: AuthorizationRefusal.BindingDisabled },
  });
  row.worker_name = "coder@1";
  row.disabled = false;
  row.tombstone = true;
  assert.throws(authorize, {
    code: WorkerErrorCode.AuthorizationRefused,
    details: { reason: AuthorizationRefusal.BindingRemoved },
  });
  row.tombstone = false;
  row.worker_name = "claude-code@1";
  assert.throws(authorize, {
    code: WorkerErrorCode.AuthorizationRefused,
    details: { reason: AuthorizationRefusal.NoNativeAgent },
  });
  row.worker_name = "coder@1";
  valid = false;
  assert.throws(authorize, {
    status: HttpStatus.BadRequest,
    code: AgentErrorCode.Unavailable,
    details: { issues },
  });
});

test("Worker authorizes one credential per distinct credential of the agents of a two-agent worker", (t) => {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  const row: NonNullable<ReturnType<WorkerBindingRowOf>> = {
    binding_id: createIdentity("binding"),
    project_id: createIdentity("project"),
    resource_identity: "worker:kanthord:two-agent",
    worker_name: TWO_AGENT_WORKER,
    entries: [],
    resource_budget: null,
    tombstone: false,
    disabled: false,
    worker_instances: [],
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      projectId: row.project_id,
      resourceIdentity: row.resource_identity,
      name: "test",
      issuedAt: 0,
    },
    "jti",
    createIdentity("worker_registration"),
  );
  const execution = {
    execution_id: createIdentity("execution"),
    project_id: row.project_id,
    worker_binding_id: row.binding_id,
    resource_identity: row.resource_identity,
  };
  const authorize = (credentials: Record<string, string>) =>
    store.transaction((tx) =>
      authorizeModelInference(
        {
          workerBindingRowOf: (_tx, id) => (id === row.binding_id ? row : null),
          pinnedCredentialMetadata: () => null,
          credentialMetadata: () => null,
          schedulerClaims: {
            agentSelectionsOf: () =>
              Object.entries(credentials).map(([agent, credential]) =>
                pinOf(agent, { credential }),
              ),
          },
        },
        {
          declarationOf: () => twoAgentDeclarationOf(row.worker_name),
          pinnedAgentView: (_tx, _worker, selection) => ({
            valid: true,
            issues: [],
            effective: {
              agent_provider: selection.agent_provider,
              provider: selection.provider,
              credential: selection.credential,
              model_identifier: selection.model_identifier,
              reasoning_effort: selection.reasoning_effort,
            },
          }),
        },
        tx,
        identity,
        execution,
      ),
    );
  assert.deepEqual(
    authorize({ "swe@1": "shared", "re@1": "shared" }).map(
      (item) => item.credential,
    ),
    ["shared"],
  );
  assert.deepEqual(
    authorize({ "swe@1": "worker", "re@1": "reviewer" }).map(
      (item) => item.credential,
    ),
    ["worker", "reviewer"],
  );
});
