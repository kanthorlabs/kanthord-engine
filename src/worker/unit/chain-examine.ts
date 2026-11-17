import {
  BudgetEndKind,
  chain,
  type Chain,
  ChainId,
  stepNode,
} from "./chain.ts";
import { agentOpenExamine } from "./step-agent-open.ts";
import { envSetupExamine } from "./step-env-setup.ts";
import { examineTurn } from "./step-examine-turn.ts";
import {
  executionRelease,
  executionReleaseFurtherWork,
} from "./step-execution-release.ts";
import { inputsReadDependenciesExamine } from "./step-inputs-read.ts";
import { setupEntriesExamine } from "./step-setup-entries.ts";
import { verifyNode } from "./step-verify-node.ts";
import { workspaceReviewBase } from "./step-workspace-review.ts";
import { Phase } from "./telemetry.ts";

export function examineChain(): Chain {
  return chain(ChainId.Examine)
    .phase(Phase.Prepare)
    .step(workspaceReviewBase)
    .phase(Phase.Tasks)
    .step(setupEntriesExamine)
    .step(envSetupExamine)
    .step(inputsReadDependenciesExamine)
    .step(agentOpenExamine)
    .step(verifyNode)
    .step(examineTurn)
    .phase(Phase.Finish)
    .step(executionRelease)
    .budgetEnd({
      kind: BudgetEndKind.Exit,
      nodes: [stepNode(executionReleaseFurtherWork)],
    })
    .build();
}
