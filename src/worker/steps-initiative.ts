import type { Revision } from "../mission/contract.ts";
import type { NativeAgent } from "./native-agent.ts";
import {
  EndReason,
  type ExecutionEnd,
  type ExecutionRun,
} from "./execution-run.ts";
import { readObjectives, allTerminal } from "./node-reads.ts";
import { reportInstruction } from "./judgement.ts";
import { renderWorkPrompt } from "./prompt-composer.ts";
import { WorkspaceKind } from "./workspace.ts";
import type { StepsInput } from "./steps-objective.ts";

export const REPORT_SUBJECT = "Report on current objective outcomes";
export const REPORT_MEDIA_TYPE = "text/markdown";

export async function runStepsInitiative(
  input: StepsInput,
  run: ExecutionRun,
  revision: Revision,
  openAgent: (directory: string) => Promise<NativeAgent>,
): Promise<ExecutionEnd> {
  const { directory } = input.workspaces.prepareExecution({
    executionId: input.claim.executionId,
  });
  try {
    const current = await readObjectives(run);
    if (!allTerminal(current.objectives)) return await run.release(true);
    const agent = await openAgent(directory);
    const work = renderWorkPrompt({
      nodeId: input.claim.nodeId,
      revision: input.claim.pinnedRevision,
      content: revision.content,
    });
    await agent.instruct(
      work,
      reportInstruction(current.objectives, current.outcomes, current.evidence),
    );
    if (agent.budget.exhausted()) return await run.release(true);
    const report = agent.lastText();
    if (!report?.trim()) run.stop(EndReason.ReportAbsent);
    if (!allTerminal((await readObjectives(run)).objectives))
      return await run.release(true);
    await run.submitEvidence(input.claim.nodeId, {
      subject: REPORT_SUBJECT,
      assets: [
        {
          kind: "produced",
          content: {
            mediaType: REPORT_MEDIA_TYPE,
            encoding: "base64",
            data: Buffer.from(report, "utf8").toString("base64"),
          },
        },
      ],
    });
    return await run.release(false);
  } finally {
    input.workspaces.release(directory, WorkspaceKind.Execution);
  }
}
