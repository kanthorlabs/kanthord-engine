import {
  BudgetEndKind,
  chain,
  type Chain,
  ChainId,
  type ChainTasks,
  namedBranch,
  soloBranch,
  stepNode,
} from "./chain.ts";
import { examineTasksNodes, runExamineTasks } from "./foundry-examine.ts";
import { EXAMINE_PORTS, type ExaminePorts } from "./foundry-ports.ts";
import {
  executionRelease,
  executionReleaseFurtherWork,
} from "./step-execution-release.ts";
import { envSetupExamine } from "./step-env-setup.ts";
import { inputsReadExamine } from "./step-inputs-read-host.ts";
import { setupEntriesExamine } from "./step-setup-entries.ts";
import { workspaceReviewBase } from "./step-workspace-review.ts";
import { Phase } from "./telemetry.ts";

function examineTasks(): ChainTasks<ExaminePorts> {
  const nodes = examineTasksNodes();
  return {
    name: "foundryExamine",
    ports: EXAMINE_PORTS,
    nodes,
    async run(ctx, control, host) {
      const end = await runExamineTasks(
        nodes,
        {
          ...control,
          claim: ctx.claim,
          setup: ctx.setup,
          revision: ctx.revision,
          reviewWorkspace: ctx.reviewWorkspace,
          dependencies: ctx.dependencies,
        },
        host,
      );
      Object.assign(ctx, end.result);
      return end;
    },
  };
}

export function examineChain(): Chain<ExaminePorts> {
  return chain<ExaminePorts>(ChainId.Examine, EXAMINE_PORTS)
    .phase(Phase.Prepare)
    .parallel("prepare.inputs", [
      soloBranch(stepNode(inputsReadExamine)),
      namedBranch("workspace", [
        stepNode(workspaceReviewBase),
        stepNode(setupEntriesExamine),
        stepNode(envSetupExamine),
      ]),
    ])
    .tasks(examineTasks())
    .phase(Phase.Finish)
    .step(executionRelease)
    .budgetEnd({
      kind: BudgetEndKind.Exit,
      nodes: [stepNode(executionReleaseFurtherWork)],
    })
    .build();
}
