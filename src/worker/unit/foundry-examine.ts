import type { ChainNode, ExecutionCtx, FoundryEnd } from "./chain.ts";
import { stepNode } from "./chain.ts";
import type { ExaminePorts } from "./foundry-ports.ts";
import {
  type FoundryControl,
  type FoundryHost,
  pickKeys,
  runTasks,
} from "./foundry.ts";
import { agentOpenExamine } from "./step-agent-open.ts";
import { envSetupExamine } from "./step-env-setup.ts";
import { examineTurn } from "./step-examine-turn.ts";
import { inputsReadDependenciesExamine } from "./step-inputs-read.ts";
import { setupEntriesExamine } from "./step-setup-entries.ts";
import { verifyNode } from "./step-verify-node.ts";

export const EXAMINE_INPUT_KEYS = [
  "claim",
  "setup",
  "revision",
  "reviewWorkspace",
] as const;
export const EXAMINE_RESULT_KEYS = ["nodeVerification"] as const;

export interface ExamineInput
  extends
    FoundryControl,
    Pick<ExecutionCtx, (typeof EXAMINE_INPUT_KEYS)[number]> {}

export type ExamineResult = Partial<
  Pick<ExecutionCtx, (typeof EXAMINE_RESULT_KEYS)[number]>
>;

export function examineTasksNodes(): ChainNode[] {
  return [
    stepNode(setupEntriesExamine),
    stepNode(envSetupExamine),
    stepNode(inputsReadDependenciesExamine),
    stepNode(agentOpenExamine),
    stepNode(verifyNode),
    stepNode(examineTurn),
  ];
}

export function foundryExamine(
  input: ExamineInput,
  host: FoundryHost<ExaminePorts>,
): Promise<FoundryEnd<ExamineResult>> {
  return runTasks(
    {
      nodes: examineTasksNodes(),
      seed: pickKeys(input, EXAMINE_INPUT_KEYS),
      resultOf: (ctx) => pickKeys(ctx, EXAMINE_RESULT_KEYS),
    },
    input,
    host,
  );
}
