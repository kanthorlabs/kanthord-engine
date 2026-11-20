import {
  BudgetEndKind,
  type Chain,
  chain,
  ChainId,
  type ChainNode,
  type ChainStep,
  type Key,
  parallelNode,
  soloBranch,
  stepNode,
} from "./chain.ts";
import { EndReason } from "./execution-stop.ts";
import {
  IMPLEMENT_HOST_PORTS,
  type ImplementHostPorts,
} from "./foundry-ports.ts";
import { affectedDeclaration } from "./step-affected-declaration.ts";
import { agentOpenImplement } from "./step-agent-open.ts";
import { envSetupLive } from "./step-env-setup-host.ts";
import { setupEntriesLive } from "./step-setup-entries-host.ts";
import { stateOpen } from "./step-state-open.ts";
import { startInputsNode } from "./chain-implement.ts";
import { Phase } from "./telemetry.ts";

function unlessSeeded(
  seeded: ReadonlySet<Key>,
  key: Key,
  step: ChainStep,
): ChainNode[] {
  return seeded.has(key) ? [] : [stepNode(step)];
}

export function tasksPrepareChain(
  seeded: ReadonlySet<Key>,
): Chain<ImplementHostPorts> {
  return chain<ImplementHostPorts>(ChainId.TasksPrepare, IMPLEMENT_HOST_PORTS)
    .phase(Phase.Prepare)
    .nodes([
      parallelNode(
        "workspace.static",
        [
          ...unlessSeeded(seeded, "affectedTests", affectedDeclaration),
          stepNode(setupEntriesLive),
          stepNode(agentOpenImplement),
        ].map(soloBranch),
      ),
      stepNode(stateOpen),
      seeded.has("plan") ? stepNode(envSetupLive) : startInputsNode(),
    ])
    .budgetEnd({ kind: BudgetEndKind.Stop, reason: EndReason.BudgetEnd })
    .build();
}
