import {
  BudgetEndKind,
  type Chain,
  chain,
  ChainId,
  type ChainNode,
  type ChainStep,
  type Key,
  stepNode,
} from "./chain.ts";
import { EndReason } from "./execution-stop.ts";
import {
  IMPLEMENT_HOST_PORTS,
  type ImplementHostPorts,
} from "./foundry-ports.ts";
import { phaseFrame } from "./foundry-implement.ts";
import { affectedDeclaration } from "./step-affected-declaration.ts";
import { agentOpenImplement } from "./step-agent-open.ts";
import { envSetupLive } from "./step-env-setup-host.ts";
import { setupEntriesLive } from "./step-setup-entries-host.ts";
import { stateOpen } from "./step-state-open.ts";
import { unitsPlan } from "./step-units-plan.ts";
import { Phase } from "./telemetry.ts";

const TASKS_PREPARE_LOOP = "tasks_prepare";

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
    .loop(
      TASKS_PREPARE_LOOP,
      phaseFrame(Phase.Prepare, [
        ...unlessSeeded(seeded, "affectedTests", affectedDeclaration),
        stepNode(setupEntriesLive),
        stepNode(agentOpenImplement),
        stepNode(envSetupLive),
        stepNode(stateOpen),
        ...unlessSeeded(seeded, "plan", unitsPlan),
      ]),
    )
    .budgetEnd({ kind: BudgetEndKind.Stop, reason: EndReason.BudgetEnd })
    .build();
}
