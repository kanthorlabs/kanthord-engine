import assert from "node:assert/strict";
import { DeadlineKind, type Step } from "./chain.ts";
import { CODER_REPORT_SUBJECT } from "./coder-report.ts";
import { next } from "./step-support.ts";
import { REPORT_MEDIA_TYPE } from "./steps-examine.ts";

const NO_ITEMS = 0;

export const reportCoder: Step<unknown, "claim" | "state" | "reports", never> =
  {
    id: "report.coder",
    deadline: DeadlineKind.Work,
    reads: ["claim", "state", "reports"],
    writes: [],
    stops: [],
    note: "one evidence with the final text of each unit; skipped with no text",
    async run(ctx, scope, io) {
      assert.ok(ctx.state.checkouts.length > NO_ITEMS);
      if (ctx.reports.size === NO_ITEMS) return next(scope);
      const report = [...ctx.reports.values()].join("\n\n");
      await io.run.submitEvidence(ctx.claim.node_id, {
        subject: CODER_REPORT_SUBJECT,
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
    },
  };
