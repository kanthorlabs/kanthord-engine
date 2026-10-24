import type { Revision } from "../../mission/contract.ts";
import type { NativeAgent } from "./native-agent.ts";
import {
  EndReason,
  type ExecutionEnd,
  type ExecutionRun,
} from "./execution-run.ts";
import { readDependencies } from "./node-reads.ts";
import { examineInstruction } from "./judgement.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import {
  WorkspaceKind,
  workRepositoriesOf,
  type ExamineCheckout,
} from "./workspace.ts";
import {
  runSetup,
  SetupEnd,
  setupEntries,
  namedCheckouts,
  setupStop,
  type SetupResult,
} from "./environment-setup.ts";
import type { StepsInput } from "./steps-implement.ts";
import type { ExecutionBudget } from "./budget.ts";
import { ContextCancelled, DeadlineExceeded } from "../../kernel/context.ts";
import { runVerifications } from "./verification.ts";
import { reportFacts } from "./report-facts.ts";
import {
  environmentDigestsOf,
  testedCommitOf,
  verificationObserver,
} from "./method-telemetry.ts";

export const REPORT_SUBJECT = "Report on current dependency outcomes";
export const REPORT_MEDIA_TYPE = "text/markdown";

async function setUpExamine(
  input: StepsInput,
  run: ExecutionRun,
  workspace: { key: string; checkouts: readonly ExamineCheckout[] },
  deadline: number,
): Promise<SetupResult["end"]> {
  if (!workspace.checkouts.length) return SetupEnd.Pass;
  const setupInput = {
    env: input.env,
    context: run.operationContext,
    deadline,
  };
  const setup = await setupEntries(
    setupInput,
    namedCheckouts(input.setup.repositories, workspace.checkouts),
  );
  const result = await runSetup(setupInput, setup);
  if (result.end === SetupEnd.Failed) throw setupStop(result);
  return result.end;
}

export async function runStepsExamine(
  input: StepsInput,
  run: ExecutionRun,
  revision: Revision,
  budget: ExecutionBudget,
  openAgent: (
    directory: string,
    checkouts: readonly string[],
  ) => Promise<NativeAgent>,
): Promise<ExecutionEnd> {
  const deadline = Math.min(
    input.claim.created_at + input.setup.resource_budget.wall_time_ms,
    input.claim.expired_at,
  );
  const workspace = await input.workspaces.prepareExamine({
    executionId: input.claim.execution_id,
    transport: input.transport,
    sshAccess: input.sshAccess,
    context: run.operationContext,
    deadlineMs: deadline - Date.now(),
    repositories: input.setup.repositories,
  });
  const { directory, checkouts } = workspace;
  try {
    if (
      (await setUpExamine(input, run, workspace, deadline)) ===
      SetupEnd.BudgetEnd
    )
      return await run.release(true);
    const current = await readDependencies(run);
    if (budget.exhausted()) return await run.release(true);
    const agent = await openAgent(
      directory,
      checkouts.map((checkout) => checkout.directory),
    );
    if (agent.budget.exhausted()) return await run.release(true);
    const work = renderWorkPrompt(input.setup.templates, {
      node_id: input.claim.node_id,
      revision: input.claim.pinned_revision,
      content: revision.content,
      repositories: workRepositoriesOf(directory, checkouts),
    });
    const verification =
      workspace.tested_input === null
        ? null
        : await runVerifications({
            observe: verificationObserver(
              run.spans,
              testedCommitOf(workspace.tested_input),
              environmentDigestsOf(input.setup.repositories),
            ),
            directory,
            commands: revision.content.verifications,
            tested_input: workspace.tested_input,
            deadline: budget.wallDeadline(),
            context: run.operationContext,
            env: input.env,
          });
    await agent.instruct(
      work,
      examineInstruction(input.setup.templates, {
        repositories: workRepositoriesOf(directory, checkouts),
        verification,
        dependencies: current.dependencies,
        outcomes: current.outcomes,
        evidence: current.evidence,
      }),
    );
    if (agent.budget.exhausted()) return await run.release(true);
    const assessment = agent.lastText();
    if (!assessment?.trim()) run.stop(EndReason.ReportAbsent);
    const report = `${reportFacts(current.dependencies, current.outcomes, verification)}\n\n## Assessment\n\n${assessment}`;
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
      !run.operationContext.signal.aborted
    )
      return await run.release(true);
    throw error;
  } finally {
    input.workspaces.release(workspace.key, WorkspaceKind.Execution);
  }
}
