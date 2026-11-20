import type { ChainNode, ExecutionCtx, FoundryEnd } from "./chain.ts";
import { parallelNode, soloBranch, stepNode } from "./chain.ts";
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
import { setupEntriesExamine } from "./step-setup-entries.ts";
import { verifyNode } from "./step-verify-node.ts";

export const EXAMINE_INPUT_KEYS = [
  "claim",
  "setup",
  "revision",
  "reviewWorkspace",
  "dependencies",
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
    parallelNode("tasks.inputs", [
      soloBranch(stepNode(agentOpenExamine)),
      soloBranch(stepNode(verifyNode)),
    ]),
    stepNode(examineTurn),
  ];
}

export function foundryExamine(
  input: ExamineInput,
  host: FoundryHost<ExaminePorts>,
): Promise<FoundryEnd<ExamineResult>> {
  return runExamineTasks(examineTasksNodes(), input, host);
}

export function runExamineTasks(
  nodes: readonly ChainNode[],
  input: ExamineInput,
  host: FoundryHost<ExaminePorts>,
): Promise<FoundryEnd<ExamineResult>> {
  return runTasks(
    {
      nodes,
      seed: pickKeys(input, EXAMINE_INPUT_KEYS),
      resultOf: (ctx) => pickKeys(ctx, EXAMINE_RESULT_KEYS),
    },
    input,
    host,
  );
}
