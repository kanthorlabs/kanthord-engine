import type { Command } from "commander";
import type { z } from "zod";

import type { DaemonClient } from "../client.ts";
import {
  nodeShowResponse,
  nodeUpdateRequest,
  nodeUpdateResponse,
  planRevisionsResponse,
} from "../../http/contract/graph.ts";
import { comparePaths } from "../../domain/plan-path.ts";
import { exitCodeForError } from "../exit-code.ts";
import { nodeCommand } from "./index.ts";

export type NodeUpdateCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
  readFile: (path: string) => string;
}>;

type NodeUpdateBody = z.infer<typeof nodeUpdateRequest>["node"];

function normalized(identities: readonly string[]): string[] {
  const sorted = [...identities].sort(comparePaths);
  const result: string[] = [];
  for (const identity of sorted) {
    if (result[result.length - 1] !== identity) {
      result.push(identity);
    }
  }
  return result;
}

function equalIdentities(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function registerNodeUpdate(input: NodeUpdateCliInput): void {
  const group = nodeCommand(input.program);
  if (group.commands.some((command) => command.name() === "update")) {
    return;
  }
  group
    .command("update")
    .description("update a node")
    .option("--id <id>", "node id")
    .option("--kind <kind>", "node kind")
    .option("--title <text>", "node title")
    .option("--parent <id>", "parent node id")
    .option("--repo <name>", "repository name")
    .option("--worker <name>", "worker name")
    .option("--no-worker", "clear the worker")
    .option("--instruction <path>", "instruction text")
    .option("--acceptance <path>", "acceptance text")
    .option("--depends-on <id...>", "dependency node ids")
    .option("--no-depends-on", "clear the dependency list")
    .action(
      async (options: {
        id?: string;
        kind?: string;
        title?: string;
        parent?: string;
        repo?: string;
        worker?: string | false;
        instruction?: string;
        acceptance?: string;
        dependsOn?: string[] | false;
      }) => {
        if (options.id === undefined) {
          input.stderr("kanthord: invalid-request: --id is required\n");
          input.fail();
          return;
        }
        const showResult = await input.client.call("node.show", undefined, {
          id: options.id,
        });
        if (!showResult.ok) {
          input.stderr(`kanthord: ${showResult.code}: ${showResult.message}\n`);
          input.exit(exitCodeForError(showResult.code, showResult.status));
          return;
        }
        const show = nodeShowResponse.parse(showResult.body);
        if (options.kind !== undefined && options.kind !== show.kind) {
          input.stderr(
            `kanthord: invalid-request: the stored node is a ${show.kind}, not a ${options.kind}\n`,
          );
          input.fail();
          return;
        }
        const dependsOn =
          options.dependsOn === undefined
            ? show.dependencies
            : options.dependsOn === false
              ? []
              : options.dependsOn;
        const worker =
          options.worker === undefined
            ? show.worker
            : options.worker === false
              ? null
              : options.worker;
        const parentChanged =
          options.parent !== undefined &&
          options.parent !== show.parentId &&
          show.kind !== "initiative";
        const dependsOnChanged =
          options.dependsOn !== undefined &&
          !equalIdentities(
            normalized(dependsOn),
            normalized(show.dependencies),
          );
        let fromRevision: string;
        if (parentChanged || dependsOnChanged) {
          const revisionsResult = await input.client.call(
            "plan.revisions",
            undefined,
            { id: show.projectId },
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
          const revisionsBody = planRevisionsResponse.parse(
            revisionsResult.body,
          );
          fromRevision = revisionsBody.revisions[0]?.id ?? show.revision;
        } else {
          fromRevision = show.revision;
        }
        let instruction: string;
        try {
          instruction =
            options.instruction === undefined
              ? show.instruction
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
              ? (show.acceptance ?? "")
              : input.readFile(options.acceptance);
        } catch {
          input.stderr(
            `kanthord: invalid-request: cannot read ${options.acceptance}\n`,
          );
          input.fail();
          return;
        }
        const node: NodeUpdateBody =
          show.kind === "initiative"
            ? {
                kind: "initiative",
                title: options.title ?? show.title,
                instruction,
                worker,
                dependsOn,
              }
            : show.kind === "objective"
              ? {
                  kind: "objective",
                  title: options.title ?? show.title,
                  parentId: options.parent ?? show.parentId ?? "",
                  repo: options.repo ?? show.repo ?? "",
                  instruction,
                  worker,
                  dependsOn,
                }
              : {
                  kind: "task",
                  title: options.title ?? show.title,
                  parentId: options.parent ?? show.parentId ?? "",
                  instruction,
                  acceptance,
                  worker,
                  dependsOn,
                };
        const updateResult = await input.client.call(
          "node.update",
          { fromRevision, node },
          { id: options.id },
        );
        if (!updateResult.ok) {
          input.stderr(
            `kanthord: ${updateResult.code}: ${updateResult.message}\n`,
          );
          input.exit(exitCodeForError(updateResult.code, updateResult.status));
          return;
        }
        const body = nodeUpdateResponse.parse(updateResult.body);
        input.stdout(`kanthord: revision ${body.revision}\n`);
        for (const finding of body.completeness) {
          input.stderr(
            `kanthord: completeness: ${finding.code} ${finding.message}\n`,
          );
        }
      },
    );
}
