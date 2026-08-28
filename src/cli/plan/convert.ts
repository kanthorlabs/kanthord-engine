import type { Command } from "commander";
import { basename, dirname, resolve } from "node:path";

import { comparePaths } from "../../domain/plan-path.ts";
import {
  convertHarnessPlan,
  type ConvertedPlanDocument,
} from "./convert-harness-plan.ts";
import type { PlanDirectoryDependencies } from "./directory.ts";
import { readPlanDirectory, writePlanDirectory } from "./directory.ts";
import { planCommand } from "./index.ts";

export type PlanConvertCliInput = Readonly<{
  program: Command;
  cwd: string;
  fs: PlanDirectoryDependencies;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

const refuse = (input: PlanConvertCliInput, message: string): void => {
  input.stderr(`kanthord: invalid-request: ${message}\n`);
  input.fail();
};

export function registerPlanConvert(input: PlanConvertCliInput): void {
  const group = planCommand(input.program);
  if (group.commands.some((command) => command.name() === "convert")) {
    return;
  }
  group
    .command("convert")
    .description("convert an expanded EPIC into plan documents")
    .option("--from <epic-file>", "expanded EPIC file")
    .option("--repo <name>", "repository name for every objective")
    .option("--to <directory>", "output directory")
    .action(async (options: { from?: string; repo?: string; to?: string }) => {
      if (options.from === undefined) {
        refuse(input, "--from is required");
        return;
      }
      if (options.repo === undefined) {
        refuse(input, "--repo is required");
        return;
      }
      if (options.to === undefined) {
        refuse(input, "--to is required");
        return;
      }

      const epicPath = resolve(input.cwd, options.from);
      const outputRoot = resolve(input.cwd, options.to);
      const epicSlug = basename(epicPath, ".md");
      const storyRoot = resolve(dirname(epicPath), "../stories", epicSlug);

      let epicContent: string;
      try {
        epicContent = input.fs.readFile(epicPath);
      } catch {
        refuse(input, `cannot read ${epicPath}`);
        return;
      }

      let names: readonly string[];
      try {
        names = input.fs
          .readDirectory(storyRoot)
          .filter(
            (name) => !name.endsWith("/") && /^[0-9]{2}-.*\.md$/.test(name),
          )
          .sort(comparePaths);
      } catch {
        refuse(input, `cannot read ${storyRoot}`);
        return;
      }

      const stories: Array<Readonly<{ path: string; content: string }>> = [];
      for (const name of names) {
        const path = `${storyRoot}/${name}`;
        try {
          stories.push({ path, content: input.fs.readFile(path) });
        } catch {
          refuse(input, `cannot read ${path}`);
          return;
        }
      }

      let documents: readonly ConvertedPlanDocument[];
      try {
        documents = convertHarnessPlan({
          epic: { path: epicPath, content: epicContent },
          stories,
          repository: options.repo,
        });
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        refuse(input, error.message);
        return;
      }

      try {
        if (readPlanDirectory(input.fs, outputRoot).length > 0) {
          refuse(input, `${outputRoot}/plan is not empty`);
          return;
        }
      } catch {
        refuse(input, `cannot read ${outputRoot}/plan`);
        return;
      }

      const removed = writePlanDirectory(input.fs, {
        root: outputRoot,
        documents,
      });
      if (removed.length > 0) {
        throw new Error("plan convert removed an existing document");
      }
      const storyCount = (documents.length - 1) / 2;
      input.stdout(
        `kanthord: converted ${storyCount} story into ${documents.length} document under ${outputRoot}/plan\n`,
      );
    });
}
