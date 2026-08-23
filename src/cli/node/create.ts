import type { Command } from "commander";
import type { z } from "zod";

import type { DaemonClient } from "../client.ts";
import {
  nodeCreateRequest,
  nodeCreateResponse,
  planRevisionsResponse,
} from "../../http/contract/graph.ts";
import { exitCodeForError } from "../exit-code.ts";
import { nodeCommand } from "./index.ts";

export type NodeCreateCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
  readFile: (path: string) => string;
}>;

type NodeCreateBody = z.infer<typeof nodeCreateRequest>["node"];

export function registerNodeCreate(input: NodeCreateCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "create")) {
    return;
  }
  group
    .command("create")
    .description("create a node")
    .option("--project <id>", "project id")
    .option("--kind <kind>", "node kind")
    .option("--title <text>", "node title")
    .option("--parent <id>", "parent node id")
    .option("--repo <name>", "repository name")
    .option("--worker <name>", "worker name")
    .option("--instruction <path>", "instruction text")
    .option("--acceptance <path>", "acceptance text")
    .option("--depends-on <id...>", "dependency node ids")
    .action(
      async (options: {
        project?: string;
        kind?: string;
        title?: string;
        parent?: string;
        repo?: string;
        worker?: string;
        instruction?: string;
        acceptance?: string;
        dependsOn?: string[];
      }) => {
        if (options.project === undefined) {
          input.stderr("kanthord: invalid-request: --project is required\n");
          input.fail();
          return;
        }
        if (options.kind === undefined) {
          input.stderr("kanthord: invalid-request: --kind is required\n");
          input.fail();
          return;
        }
        if (options.title === undefined) {
          input.stderr("kanthord: invalid-request: --title is required\n");
          input.fail();
          return;
        }
        const worker = options.worker ?? null;
        const dependsOn = options.dependsOn ?? [];
        let instruction: string;
        try {
          instruction =
            options.instruction === undefined
              ? ""
              : input.readFile(options.instruction);
        } catch {
          input.stderr(
            `kanthord: invalid-request: cannot read ${options.instruction}\n`,
          );
          input.fail();
          return;
        }
        let acceptance: string;
        try {
          acceptance =
            options.acceptance === undefined
              ? ""
              : input.readFile(options.acceptance);
        } catch {
          input.stderr(
            `kanthord: invalid-request: cannot read ${options.acceptance}\n`,
          );
          input.fail();
          return;
        }
        let node: NodeCreateBody;
        if (options.kind === "initiative") {
          node = {
            kind: "initiative",
            title: options.title,
            instruction,
            worker,
            dependsOn,
          };
        } else if (options.kind === "objective") {
          if (options.parent === undefined) {
            input.stderr("kanthord: invalid-request: --parent is required\n");
            input.fail();
            return;
          }
          if (options.repo === undefined) {
            input.stderr("kanthord: invalid-request: --repo is required\n");
            input.fail();
            return;
          }
          node = {
            kind: "objective",
            title: options.title,
            parentId: options.parent,
            repo: options.repo,
            instruction,
            worker,
            dependsOn,
          };
        } else if (options.kind === "task") {
          if (options.parent === undefined) {
            input.stderr("kanthord: invalid-request: --parent is required\n");
            input.fail();
            return;
          }
          node = {
            kind: "task",
            title: options.title,
            parentId: options.parent,
            instruction,
            acceptance,
            worker,
            dependsOn,
          };
        } else {
          input.stderr(
            `kanthord: invalid-request: unknown kind ${options.kind}\n`,
          );
          input.fail();
          return;
        }
        const revisionsResult = await input.client.call(
          "plan.revisions",
          undefined,
          { id: options.project },
        );
        if (!revisionsResult.ok) {
          input.stderr(
            `kanthord: ${revisionsResult.code}: ${revisionsResult.message}\n`,
          );
          input.exit(
            exitCodeForError(revisionsResult.code, revisionsResult.status),
          );
          return;
        }
        const revisionsBody = planRevisionsResponse.parse(revisionsResult.body);
        const createResult = await input.client.call(
          "node.create",
          {
            fromRevision: revisionsBody.revisions[0]?.id ?? null,
            node,
          },
          { id: options.project },
        );
        if (!createResult.ok) {
          input.stderr(
            `kanthord: ${createResult.code}: ${createResult.message}\n`,
          );
          input.exit(exitCodeForError(createResult.code, createResult.status));
          return;
        }
        const body = nodeCreateResponse.parse(createResult.body);
        input.stdout(`kanthord: id ${body.id}\n`);
        input.stdout(`kanthord: revision ${body.revision}\n`);
        for (const finding of body.completeness) {
          input.stderr(
            `kanthord: completeness: ${finding.code} ${finding.message}\n`,
          );
        }
      },
    );
}
