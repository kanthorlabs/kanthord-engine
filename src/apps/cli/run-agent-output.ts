import { constants, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { userInfo } from "node:os";
import { Diagnostic } from "../../kernel/errors.ts";
import { openPrivate } from "../../kernel/files.ts";

const OUTPUT_INVALID = "cli.run.agent.output_invalid";
const OUTPUT_PLACE = "cli.run.agent.output_place";
const STDOUT = "stdout";
const PRIVATE_MODE = 0o600;
const GROUP_OTHER_WRITE = 0o022;
const MODE_MASK = 0o777;
const LABEL_WIDTH = 11;
const MS_PER_SECOND = 1000;
const PRICE_DECIMALS = 6;

const OutputKind = { Stdout: "stdout", Path: "path" } as const;

interface StdoutOutputTarget {
  kind: typeof OutputKind.Stdout;
}

interface PathOutputTarget {
  kind: typeof OutputKind.Path;
  path: string;
}

export type OutputTarget = StdoutOutputTarget | PathOutputTarget;

export function parseOutputTarget(value: string | undefined): OutputTarget {
  if (value === undefined || value === STDOUT)
    return { kind: OutputKind.Stdout };
  return { kind: OutputKind.Path, path: resolve(value) };
}

function isUnder(path: string, dir: string): boolean {
  return path.startsWith(dir + "/") || path === dir;
}

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function sessionRealPath(sessionAbsPath: string): string {
  const realDir = tryRealpath(dirname(sessionAbsPath));
  if (realDir === null) return sessionAbsPath;
  return realDir + "/" + sessionAbsPath.split("/").at(-1);
}

function checkOutputParentDir(
  outputPath: string,
  uid: number,
  fields: [string, string][],
): void {
  const realParent = tryRealpath(dirname(outputPath));
  if (realParent === null)
    throw new Diagnostic(
      OUTPUT_INVALID,
      "run agent: the output file parent directory is absent or not a directory.",
      { fields },
    );
  const parentStat = statSync(realParent, { throwIfNoEntry: false });
  if (!parentStat?.isDirectory())
    throw new Diagnostic(
      OUTPUT_INVALID,
      "run agent: the output file parent directory is absent or not a directory.",
      { fields },
    );
  if (parentStat.uid !== uid)
    throw new Diagnostic(
      OUTPUT_INVALID,
      "run agent: another user owns the output file parent directory.",
      { fields },
    );
  if (parentStat.mode & GROUP_OTHER_WRITE)
    throw new Diagnostic(
      OUTPUT_INVALID,
      "run agent: the output file parent directory has a group or other write bit.",
      { fields },
    );
}

function checkExistingOutputEntry(
  outputPath: string,
  uid: number,
  fields: [string, string][],
): void {
  const entry = lstatSync(outputPath, { throwIfNoEntry: false });
  if (entry === undefined) return;
  if (entry.isSymbolicLink())
    throw new Diagnostic(
      OUTPUT_INVALID,
      "run agent: the output file path is a symbolic link.",
      { fields },
    );
  if (!entry.isFile())
    throw new Diagnostic(
      OUTPUT_INVALID,
      "run agent: the output file path is not a regular file.",
      { fields },
    );
  if (entry.uid !== uid)
    throw new Diagnostic(
      OUTPUT_INVALID,
      "run agent: another user owns the output file.",
      { fields },
    );
  if ((entry.mode & MODE_MASK) !== PRIVATE_MODE)
    throw new Diagnostic(
      OUTPUT_INVALID,
      "run agent: the output file mode is not 0600.",
      { fields },
    );
}

export interface OutputPathContext {
  workspaceRealPath: string;
  piDirectoryPath: string;
  authRealPath: string | null;
  sessionAbsPath: string;
}

export function checkOutputPath(
  outputPath: string,
  context: OutputPathContext,
): void {
  const { workspaceRealPath, piDirectoryPath, authRealPath, sessionAbsPath } =
    context;
  const fields = [["path", outputPath]] as [string, string][];
  const uid = userInfo().uid;

  checkOutputParentDir(outputPath, uid, fields);
  checkExistingOutputEntry(outputPath, uid, fields);

  if (
    isUnder(outputPath, workspaceRealPath) ||
    isUnder(outputPath, piDirectoryPath)
  )
    throw new Diagnostic(
      OUTPUT_PLACE,
      "run agent: the output file is inside the workspace or the pi directory.",
      { fields },
    );

  const realOutput = tryRealpath(outputPath);
  if (authRealPath !== null && realOutput === authRealPath)
    throw new Diagnostic(
      OUTPUT_PLACE,
      "run agent: the output file is the --auth file.",
      { fields },
    );

  if (realOutput !== null && realOutput === sessionRealPath(sessionAbsPath))
    throw new Diagnostic(
      OUTPUT_PLACE,
      "run agent: the output file is the session file.",
      { fields },
    );
}

export function openOutputFile(outputPath: string): number {
  return openPrivate(
    outputPath,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
  );
}

function pad(label: string): string {
  return label.padEnd(LABEL_WIDTH, " ");
}

export interface UsageStats {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface TextLayoutInput {
  agent: string;
  end: string;
  model: string;
  reasoning_effort: string;
  exitCode: number;
  classValue: string;
  failure: string | null;
  budget_reached: string | null;
  budgetDisplay: string;
  duration_ms: number;
  model_calls: number;
  tool_calls: number;
  usage: UsageStats;
  list_price_usd: number;
  session: string;
  workspace: string;
  text: string | null;
  provider: string;
}

export function textLayout(input: TextLayoutInput): string {
  const lines: string[] = [];
  lines.push(`${input.agent} ${input.end}`);
  lines.push(
    `  ${pad("model")}${input.provider}/${input.model}:${input.reasoning_effort}`,
  );
  lines.push(`  ${pad("exit")}${input.exitCode}`);
  lines.push(`  ${pad("class")}${input.classValue}`);
  if (input.failure !== null) lines.push(`  ${pad("failure")}${input.failure}`);
  lines.push(`  ${pad("budget")}${input.budgetDisplay}`);
  if (input.budget_reached !== null)
    lines.push(`  ${pad("reached")}${input.budget_reached}`);
  const durationS = (input.duration_ms / MS_PER_SECOND).toFixed(1);
  lines.push(`  ${pad("duration")}${durationS} s`);
  lines.push(
    `  ${pad("calls")}${input.model_calls} model, ${input.tool_calls} tool`,
  );
  const u = input.usage;
  lines.push(
    `  ${pad("tokens")}${u.input} input, ${u.output} output, ${u.cache_read} cache read, ${u.cache_write} cache write`,
  );
  lines.push(
    `  ${pad("list price")}${input.list_price_usd.toFixed(PRICE_DECIMALS)} usd`,
  );
  lines.push(`  ${pad("session")}${input.session}`);
  lines.push(`  ${pad("workspace")}${input.workspace}`);
  lines.push("");
  lines.push(input.text ?? "(no text)");
  return lines.join("\n");
}
