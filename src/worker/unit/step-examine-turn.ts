import assert from "node:assert/strict";
import { PromptTemplate } from "../../agent/contract.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import { DeadlineKind, type Step } from "./chain.ts";
import { EndReason } from "./execution-run.ts";
import type { ExaminePorts } from "./foundry-ports.ts";
import { examineInstruction } from "./judgement.ts";
import { reportFacts } from "./report-facts.ts";
import {
  budgetEnd,
  budgetMapped,
  next,
  submittedEvidence,
} from "./step-support.ts";
import { REPORT_MEDIA_TYPE, REPORT_SUBJECT } from "./steps-examine.ts";
import { workRepositoriesOf } from "./workspace.ts";

export const examineTurn: Step<
  unknown,
  | "agent"
  | "claim"
  | "setup"
  | "revision"
  | "reviewWorkspace"
  | "nodeVerification"
  | "dependencies",
  never,
  ExaminePorts
> = {
  id: "examine.turn",
  deadline: DeadlineKind.Work,
  reads: [
    "agent",
    "claim",
    "setup",
    "revision",
    "reviewWorkspace",
    "nodeVerification",
    "dependencies",
  ],
  writes: [],
  stops: ["report_absent", "provider_failed"],
  llm: true,
  note: "port: evidence.submit; Examine; budget end after the turn; submits the report evidence",
  run(ctx, scope, io) {
    return budgetMapped(io, scope, async () => {
      const { agent, claim, setup, dependencies: current } = ctx;
      const { directory, checkouts } = ctx.reviewWorkspace;
      const verification = ctx.nodeVerification;
      assert.ok(current);
      const work = renderWorkPrompt(setup.templates, {
        node_id: claim.node_id,
        revision: claim.pinned_revision,
        content: ctx.revision.content,
        repositories: workRepositoriesOf(directory, checkouts),
      });
      await agent.instruct(
        work,
        examineInstruction(setup.templates, {
          repositories: workRepositoriesOf(directory, checkouts),
          verification,
          dependencies: current.dependencies,
          outcomes: current.outcomes,
          evidence: current.evidence,
        }),
        PromptTemplate.Examine,
      );
      if (agent.budget.exhausted()) return budgetEnd(scope);
      const assessment = agent.lastText();
      if (!assessment?.trim()) io.run.stop(EndReason.ReportAbsent);
      const report = `${reportFacts(current.dependencies, current.outcomes, verification)}\n\n## Assessment\n\n${assessment}`;
      await submittedEvidence(io, {
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
      return next(scope);
    });
  },
};
