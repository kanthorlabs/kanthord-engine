import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Command } from "commander";
import { resolveClient } from "../../gateway/client.ts";
import { CommandName, PROGRAM_NAME } from "./constants.ts";
import { requireToken, singleUse } from "./shared.ts";
import { CouncilErrorCode } from "./council/contract.ts";
import { httpEnablementReader, requireEnabled } from "./council/enablement.ts";
import {
  renderPlanFiles,
  renderRecord,
  requireEmptyOutput,
  writeOutput,
} from "./council/output.ts";
import { runCouncil } from "./council/run.ts";
import { askInSession, httpWorkbenchPort } from "./council/session.ts";

async function council(idea: string, command: Command): Promise<void> {
  const options = command.optsWithGlobals();
  const { endpoint, token } = resolveClient(options);
  requireToken(token, CouncilErrorCode.TokenRequired);
  const out = resolve(options.out);
  requireEmptyOutput(out);
  const configurations = await requireEnabled(
    httpEnablementReader(endpoint, token),
  );
  const port = httpWorkbenchPort(endpoint, token);
  const record = await runCouncil(
    idea,
    (agentName, text) =>
      askInSession(port, agentName, configurations.get(agentName)!, text),
    (step) => process.stderr.write(`council: ${step}\n`),
  );
  const files = renderPlanFiles(record.plan);
  writeOutput(out, files, renderRecord(record));
  process.stdout.write(
    `Wrote ${files.length} plan files and council.md to ${out}\n`,
  );
}

export function addCouncilCommand(program: Command): void {
  assert.equal(program.name(), PROGRAM_NAME);
  assert.ok(
    !program.commands.some((command) => command.name() === CommandName.Council),
  );
  program
    .command(CommandName.Council)
    .description(
      "Ask the council agents for a development direction and write plan files",
    )
    .argument("<idea>", "The raw idea")
    .requiredOption(
      "--out <dir>",
      "Absent or empty directory for the plan files and council.md",
    )
    .option("--endpoint <url>", "Server endpoint")
    .option(
      "--token <token>",
      "Caller JWT (otherwise KANTHORD_TOKEN or cli.yaml)",
      singleUse("--token"),
    )
    .action(async (idea: string, _options: unknown, command: Command) =>
      council(idea, command),
    );
}
