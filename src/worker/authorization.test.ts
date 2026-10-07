import assert from "node:assert/strict";
import { test } from "node:test";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { HttpStatus } from "../kernel/http.ts";
import { authorizeModelInference } from "./authorization.ts";
import { getWorkerDeclaration } from "./catalog.ts";
import {
  AuthorizationRefusal,
  WorkerErrorCode,
  type WorkerBindingRowOf,
} from "./contract.ts";
import { AgentErrorCode } from "../agent/contract.ts";

test("Worker authorizes the pinned inference configuration and refuses each broken binding chain", (t) => {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  const row: NonNullable<ReturnType<WorkerBindingRowOf>> = {
    bindingId: createIdentity("binding"),
    projectId: createIdentity("project"),
    resourceIdentity: "worker:kanthord:worker",
    workerName: "general@1",
    entries: [],
    resourceBudget: null,
    tombstone: false,
    disabled: false,
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      projectId: row.projectId,
      resourceIdentity: row.resourceIdentity,
      name: "test",
      issuedAt: 0,
    },
    "jti",
  );
  const execution = {
    execution_id: createIdentity("execution"),
    project_id: row.projectId,
    worker_binding_id: row.bindingId,
    resource_identity: row.resourceIdentity,
  };
  let valid = true;
  const issues = [{ path: ["agent"], code: AgentErrorCode.Unavailable }];
  const authorize = (change = {}) =>
    store.transaction((tx) =>
      authorizeModelInference(
        {
          workerBindingRowOf: (_tx, id) => (id === row.bindingId ? row : null),
        },
        {
          declarationOf: () => getWorkerDeclaration(row.workerName) ?? null,
          workerAgentView: (_tx, worker, agent, entry) => {
            assert.equal(worker, row.workerName);
            assert.equal(
              agent,
              getWorkerDeclaration(row.workerName)?.agentName,
            );
            return {
              valid,
              issues: valid ? [] : issues,
              defaults: null,
              effective: valid
                ? {
                    agentProvider: entry?.agentProvider ?? "default",
                    provider: "anthropic",
                    credential: "anthro-1",
                    modelIdentifier: "claude-sonnet-4-5",
                    reasoningEffort: "off",
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
  assert.deepEqual(authorize(), {
    credential: "anthro-1",
    platform: "anthropic",
    provider_id: "anthropic",
    agent_provider: "default",
  });
  row.entries = [{ agent: "swe@1", agentProvider: "override" }];
  assert.equal(authorize().agent_provider, row.entries[0]!.agentProvider);
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
  assert.throws(authorize, {
    code: WorkerErrorCode.AuthorizationRefused,
    details: { reason: AuthorizationRefusal.BindingDisabled },
  });
  row.disabled = false;
  row.tombstone = true;
  assert.throws(authorize, {
    code: WorkerErrorCode.AuthorizationRefused,
    details: { reason: AuthorizationRefusal.BindingRemoved },
  });
  row.tombstone = false;
  row.workerName = "claude@1";
  assert.throws(authorize, {
    code: WorkerErrorCode.AuthorizationRefused,
    details: { reason: AuthorizationRefusal.NoNativeAgent },
  });
  row.workerName = "general@1";
  valid = false;
  assert.throws(authorize, {
    status: HttpStatus.BadRequest,
    code: AgentErrorCode.Unavailable,
    details: { issues },
  });
});
