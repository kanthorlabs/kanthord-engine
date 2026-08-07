import type { Command } from "commander";
import { ulid } from "ulid";

import type { DaemonClient } from "../client.ts";
import {
  planImportResponse,
  planRevisionsResponse,
  planValidateResponse,
} from "../../http/contract/graph.ts";
import { choicesChangedDetails } from "../../http/contract/error-details.ts";
import type { ConfirmDependencies } from "../confirm.ts";
import { comparePaths } from "../../domain/plan-path.ts";
import type { PlanDirectoryDependencies } from "./directory.ts";
import { readPlanDirectory, writePlanDirectory } from "./directory.ts";
import { planCommand } from "./index.ts";

export type PlanImportCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  confirm: ConfirmDependencies;
  cwd: string;
  fs: PlanDirectoryDependencies;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerPlanImport(input: PlanImportCliInput): void {
  const group = planCommand(input.program);
  if (group.commands.some((command) => command.name() === "import")) {
    return;
  }
  group
    .command("import")
    .description("import the plan documents")
    .option("--project <id>", "project id")
    .option("--directory <path>", "directory holding the plan")
    .option("--yes", "take every suggestion without prompting")
    .action(
      async (options: {
        project?: string;
        directory?: string;
        yes?: boolean;
      }) => {
        if (options.project === undefined) {
          input.stderr("kanthord: invalid-request: --project is required\n");
          input.fail();
          return;
        }
        const root = options.directory ?? input.cwd;
        const documents = readPlanDirectory(input.fs, root);
        if (documents.length === 0) {
          input.stderr(
            `kanthord: invalid-request: no plan document under ${root}/plan\n`,
          );
          input.fail();
          return;
        }
        const id = options.project;
        const revisionsResult = await input.client.call(
          "plan.revisions",
          undefined,
          { id },
        );
        if (!revisionsResult.ok) {
          input.stderr(
            `kanthord: ${revisionsResult.code}: ${revisionsResult.message}\n`,
          );
          input.fail();
          return;
        }
        const revisionsBody = planRevisionsResponse.parse(revisionsResult.body);
        const fromRevision = revisionsBody.revisions[0]?.id ?? null;
        const validateResult = await input.client.call(
          "plan.validate",
          { fromRevision, documents },
          { id },
        );
        if (!validateResult.ok) {
          input.stderr(
            `kanthord: ${validateResult.code}: ${validateResult.message}\n`,
          );
          input.fail();
          return;
        }
        const validated = planValidateResponse.parse(validateResult.body);
        if (validated.findings.length > 0) {
          for (const finding of validated.findings) {
            input.stderr(
              `kanthord: plan-invalid: ${finding.code} ${finding.path ?? "-"} ${finding.message}\n`,
            );
          }
          input.fail();
          return;
        }
        const choices = [...validated.choices]
          .map((entry) => ({ id: entry.id, take: entry.suggested }))
          .sort((left, right) => comparePaths(left.id, right.id));
        if (options.yes !== true && input.confirm.isTty) {
          for (const choice of choices) {
            input.stdout(`kanthord: ${choice.id} -> ${choice.take}\n`);
          }
          const answer = await input.confirm.prompt("import this plan? [y/N] ");
          if (!/^y/i.test(answer.trim())) {
            input.stderr("kanthord: cancelled\n");
            input.fail();
            return;
          }
        }
        const importResult = await input.client.call(
          "plan.import",
          {
            fromRevision,
            importId: `imp_${ulid()}`,
            documents: validated.documents,
            choices,
            validatedRevision: validated.revision,
            documentsHash: validated.documentsHash,
          },
          { id },
        );
        if (!importResult.ok) {
          input.stderr(
            `kanthord: ${importResult.code}: ${importResult.message}\n`,
          );
          if (importResult.code === "choices-stale") {
            input.stderr(
              "kanthord: choices-stale: the plan moved since validation; export and retry\n",
            );
          }
          if (importResult.code === "choices-changed") {
            const details = choicesChangedDetails.parse(importResult.details);
            const ids = details.conflicts
              .map((conflict) => conflict.id)
              .join(",");
            input.stderr(`kanthord: choices-changed: ${ids}\n`);
          }
          input.fail();
          return;
        }
        const body = planImportResponse.parse(importResult.body);
        const removed = writePlanDirectory(input.fs, {
          root,
          documents: body.documents,
        });
        input.stdout(`kanthord: revision ${body.revision}\n`);
        input.stdout(`kanthord: wrote ${body.documents.length} document\n`);
        input.stdout(`kanthord: removed ${removed.length} document\n`);
        input.stdout(
          `kanthord: absent ${body.absent.length === 0 ? "<none>" : body.absent.join(",")}\n`,
        );
      },
    );
}
