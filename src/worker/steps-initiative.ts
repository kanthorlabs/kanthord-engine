import type { Revision } from "../mission/contract.ts";
import type { NativeAgent } from "./native-agent.ts";
import {
  EndReason,
  type ExecutionEnd,
  type ExecutionRun,
} from "./execution-run.ts";
import { readObjectives, allTerminal } from "./node-reads.ts";
import { reportInstruction } from "./judgement.ts";
import { renderWorkPrompt } from "../agent/prompt-composer.ts";
import { WorkspaceKind } from "./workspace.ts";
import type { StepsInput } from "./steps-objective.ts";
import { ExecutionBudget } from "./budget.ts";
import { ContextCancelled, DeadlineExceeded } from "../kernel/context.ts";
import { runVerifications } from "./verification.ts";
import { reportFacts } from "./report-facts.ts";

export const REPORT_SUBJECT = "Report on current objective outcomes";
export const REPORT_MEDIA_TYPE = "text/markdown";

export async function runStepsInitiative(
  input: StepsInput,
  run: ExecutionRun,
  revision: Revision,
  openAgent: (directory: string) => Promise<NativeAgent>,
): Promise<ExecutionEnd> {
  const budget = new ExecutionBudget({
    ...input.claim,
    resource_budget: input.setup.resource_budget,
  });
  const deadline = Math.min(
    input.claim.created_at + input.setup.resource_budget.wall_time_ms,
    input.claim.expired_at,
  );
  const workspace = await input.workspaces.prepareInitiative({
    executionId: input.claim.execution_id,
    transport: input.transport,
    context: run.operationContext,
    deadlineMs: deadline - Date.now(),
    repositories: input.setup.repositories,
  });
  const { directory } = workspace;
  try {
    const current = await readObjectives(run);
    if (!allTerminal(current.objectives)) return await run.release(true);
    if (budget.exhausted()) return await run.release(true);
    const agent = await openAgent(directory);
    if (agent.budget.exhausted()) return await run.release(true);
    const work = renderWorkPrompt({
      node_id: input.claim.node_id,
      revision: input.claim.pinned_revision,
      content: revision.content,
    });
    const verification =
      workspace.tested_input === null
        ? null
        : await runVerifications({
            directory,
            commands: revision.content.verifications,
            tested_input: workspace.tested_input,
            deadline: budget.wallDeadline(),
            context: run.operationContext,
          });
    await agent.instruct(
      work,
      reportInstruction(
        current.objectives,
        current.outcomes,
        current.evidence,
        verification,
      ),
    );
    if (agent.budget.exhausted()) return await run.release(true);
    const assessment = agent.lastText();
    if (!assessment?.trim()) run.stop(EndReason.ReportAbsent);
    const report = `${reportFacts(current.objectives, current.outcomes, verification)}\n\n## Assessment\n\n${assessment}`;
    if (!allTerminal((await readObjectives(run)).objectives))
      return await run.release(true);
    await run.submitEvidence(input.claim.node_id, {
      subject: REPORT_SUBJECT,
      assets: [
        {
          kind: "produced",
          content: {
            media_type: REPORT_MEDIA_TYPE,
            encoding: "base64",
            data: Buffer.from(report, "utf8").toString("base64"),
          },
        },
      ],
    });
    return await run.release(false);
  } catch (error) {
    if (
      (error instanceof ContextCancelled ||
        error instanceof DeadlineExceeded) &&
      budget.exhausted() &&
      !run.operationContext.err()
    )
      return await run.release(true);
    throw error;
  } finally {
    input.workspaces.release(directory, WorkspaceKind.Execution);
  }
}
