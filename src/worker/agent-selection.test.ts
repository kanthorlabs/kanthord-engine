import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import { AgentChoiceKind, type AgentSelection } from "../scheduler/contract.ts";
import { agentChoice, agentSelectionsAt } from "./agent-selection.ts";
import { TWO_AGENT_WORKER, twoAgentDeclarationOf } from "./test-support.ts";
import { InstancePlacement, type WorkerEntry } from "./contract.ts";
import { insertInstance } from "./instance-rows.ts";
import { workerMigrations } from "./migrations.ts";

const SWE = "swe@1";
const RE = "re@1";
const AVAILABLE_AT = 5000;
const pin: AgentSelection = {
  agent_name: SWE,
  position: 1,
  level: "binding",
  agent_provider: "qwen",
  provider: "openai-compatible",
  credential: "qwen-key",
  model_identifier: "qwen3.6-plus",
  reasoning_effort: "high",
};
const BINDING = "binding";
const ENABLEMENT = "agent_enablement_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const swePin = { agent_name: SWE, enablement_id: ENABLEMENT, position: 1 };
const tuning = { reasoning_effort: "low" };
const tx = {} as Transaction;
const CODER = "coder-1";
const RELAY_A = "relay-a";
const RELAY_B = "relay-b";
const SERVER = "server";

function withInstances<T>(
  instances: ReadonlyArray<[string, InstancePlacement]>,
  read: (transaction: Transaction) => T,
): T {
  const store = new Store(IN_MEMORY_DATABASE);
  try {
    store.migrate([{ service: "worker", migrations: workerMigrations }]);
    return store.transaction((transaction) => {
      for (const [name, placement] of instances)
        insertInstance(
          transaction,
          {
            name,
            worker: "coder@1",
            placement,
            public_key: null,
            fingerprint: null,
          },
          1,
        );
      return read(transaction);
    });
  } finally {
    store.close();
  }
}

const selected = {
  kind: "selected" as const,
  selection: pin,
  enablement_id: ENABLEMENT,
};

function choice(
  results: Record<
    string,
    | { kind: "selected"; selection: AgentSelection; enablement_id: string }
    | { kind: "cooling"; available_at: number }
    | { kind: "invalid" }
  >,
) {
  const workerName = RE in results ? TWO_AGENT_WORKER : "coder@1";
  const agents = twoAgentDeclarationOf(workerName)?.agent_names ?? [];
  assert.deepEqual([...agents].sort(), Object.keys(results).sort());
  return withInstances([[CODER, InstancePlacement.Server]], (transaction) =>
    agentChoice(
      {
        workerBindingRowOf: () =>
          ({
            worker_name: workerName,
            worker_instances: [CODER],
            entries: [{ agent: SWE, ...tuning }],
          }) as never,
        agentConfiguration: {
          selectAgent: (
            _tx: Transaction,
            agentName: string,
            entry: WorkerEntry | null,
            scope: { holders: readonly string[]; claimant: string | null },
          ) => {
            assert.deepEqual(entry, agentName === SWE ? tuning : null);
            assert.deepEqual(scope, {
              holders: ["server"],
              claimant: "server",
            });
            return results[agentName]!;
          },
        } as never,
      },
      { declarationOf: twoAgentDeclarationOf },
      transaction,
      "binding",
      "server",
    ),
  );
}

test("the agent choice pins every selected agent, skips an invalid one and answers cooling for one cooling agent", () => {
  assert.deepEqual(choice({ [SWE]: selected }), {
    kind: AgentChoiceKind.Selected,
    selections: [pin],
    pins: [swePin],
  });
  assert.deepEqual(
    choice({
      [SWE]: selected,
      [RE]: { kind: "invalid" },
    }),
    { kind: AgentChoiceKind.Selected, selections: [pin], pins: [swePin] },
  );
  assert.deepEqual(
    choice({
      [SWE]: selected,
      [RE]: { kind: "cooling", available_at: AVAILABLE_AT },
    }),
    { kind: AgentChoiceKind.Cooling, available_at: AVAILABLE_AT },
  );
});

test("agentSelectionsAt resolves each pin against the entry of its agent in the pinned binding revision", () => {
  const calls: unknown[][] = [];
  const dependencies = {
    workerBindingRowOf: (_tx: Transaction, bindingId: string) => {
      assert.equal(bindingId, BINDING);
      return { entries: [{ agent: SWE, ...tuning }] } as never;
    },
    agentConfiguration: {
      selectionAt: (...args: unknown[]) => {
        calls.push(args.slice(1));
        return pin;
      },
    } as never,
  };
  const rePin = { agent_name: RE, enablement_id: ENABLEMENT, position: 0 };
  assert.deepEqual(
    agentSelectionsAt(dependencies, tx, BINDING, [swePin, rePin]),
    [pin, pin],
  );
  assert.deepEqual(calls, [
    [SWE, ENABLEMENT, tuning, 1],
    [RE, ENABLEMENT, null, 0],
  ]);
  assert.deepEqual(agentSelectionsAt(dependencies, tx, BINDING, []), []);
});

function holdersOf(
  instances: ReadonlyArray<[string, InstancePlacement]>,
  claimant: string,
) {
  const scopes: unknown[] = [];
  withInstances(instances, (transaction) =>
    agentChoice(
      {
        workerBindingRowOf: () =>
          ({
            worker_name: "coder@1",
            worker_instances: instances.map(([name]) => name),
            entries: [],
          }) as never,
        agentConfiguration: {
          selectAgent: (
            _tx: Transaction,
            _agentName: string,
            _entry: WorkerEntry | null,
            scope: { holders: readonly string[]; claimant: string | null },
          ) => {
            scopes.push(scope);
            return { kind: "invalid" };
          },
        } as never,
      },
      { declarationOf: twoAgentDeclarationOf },
      transaction,
      BINDING,
      claimant,
    ),
  );
  return scopes;
}

test("the agent choice of a worker placement binding checks every listed instance and reads the copy of the claimant", () => {
  assert.deepEqual(
    holdersOf(
      [
        [RELAY_A, InstancePlacement.Worker],
        [RELAY_B, InstancePlacement.Worker],
      ],
      RELAY_A,
    ),
    [{ holders: [RELAY_A, RELAY_B], claimant: RELAY_A }],
  );
});

test("the holders of a binding that lists a server and a worker instance are the worker instance and server", () => {
  assert.deepEqual(
    holdersOf(
      [
        [CODER, InstancePlacement.Server],
        [RELAY_A, InstancePlacement.Worker],
      ],
      SERVER,
    ),
    [{ holders: [RELAY_A, SERVER], claimant: SERVER }],
  );
});
