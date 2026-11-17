import {
  BudgetEndKind,
  chain,
  type Chain,
  ChainId,
  stepNode,
} from "./chain.ts";
import { examineTasksNodes, foundryExamine } from "./foundry-examine.ts";
import { EXAMINE_PORTS, type ExaminePorts } from "./foundry-ports.ts";
import {
  executionRelease,
  executionReleaseFurtherWork,
} from "./step-execution-release.ts";
import { workspaceReviewBase } from "./step-workspace-review.ts";
import { Phase } from "./telemetry.ts";

export function examineChain(): Chain<ExaminePorts> {
  return chain<ExaminePorts>(ChainId.Examine, EXAMINE_PORTS)
    .phase(Phase.Prepare)
    .step(workspaceReviewBase)
    .tasks({
      name: "foundryExamine",
      ports: EXAMINE_PORTS,
      nodes: examineTasksNodes(),
      async run(ctx, control, host) {
        const end = await foundryExamine(
          {
            ...control,
            claim: ctx.claim,
            setup: ctx.setup,
            revision: ctx.revision,
            reviewWorkspace: ctx.reviewWorkspace,
          },
          host,
        );
        Object.assign(ctx, end.result);
        return end;
      },
    })
    .phase(Phase.Finish)
    .step(executionRelease)
    .budgetEnd({
      kind: BudgetEndKind.Exit,
      nodes: [stepNode(executionReleaseFurtherWork)],
    })
    .build();
}
