import assert from "node:assert/strict";
import { test } from "node:test";
import type { Transaction } from "../kernel/store.ts";
import { AgentChoiceKind, type AgentSelection } from "../scheduler/contract.ts";
import { agentChoice, agentSelectionsAt } from "./agent-selection.ts";
import { TWO_AGENT_WORKER, twoAgentDeclarationOf } from "./test-support.ts";
import type { WorkerEntry } from "./contract.ts";

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
  return agentChoice(
    {
      workerBindingRowOf: () =>
        ({
          worker_name: workerName,
          entries: [{ agent: SWE, ...tuning }],
        }) as never,
      agentConfiguration: {
        selectAgent: (
          _tx: Transaction,
          agentName: string,
          entry: WorkerEntry | null,
        ) => {
          assert.deepEqual(entry, agentName === SWE ? tuning : null);
          return results[agentName]!;
        },
      } as never,
    },
    { declarationOf: twoAgentDeclarationOf },
    tx,
    "binding",
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
