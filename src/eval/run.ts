import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { agentOperations, PromptPartState } from "../agent/contract.ts";
import { CodedError } from "../kernel/errors.ts";
import { PRIVATE_FILE_MODE } from "../kernel/files.ts";
import type { WorkbenchModelRuntimeFactory } from "../workbench/index.ts";
import { EVAL_DIRECTORY, type LoadedCase, loadSuite } from "./case.ts";
import {
  casePassed,
  compare,
  type EvalRun,
  evalRunSchema,
  historyEntryOf,
  historySchema,
  mergeReruns,
  passRateOf,
  type RunResult,
} from "./compare.ts";
import {
  openSandbox,
  playCase,
  type PlayedCase,
  type Sandbox,
} from "./sandbox.ts";

export const EVAL_CONFIGURATION = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-5-5",
  reasoning_effort: "medium",
} as const;

const RunErrorCode = {
  RerunCasesAbsent: "eval.run.rerun_cases_absent",
  RerunCaseChanged: "eval.run.rerun_case_changed",
  RerunRepeatChanged: "eval.run.rerun_repeat_changed",
  Incomplete: "eval.run.incomplete",
} as const;

const ENGINE_ROOT = join(EVAL_DIRECTORY, "..");
const RUN_EXTENSION = ".json";
const ENTRY_EXTENSION = ".entry.json";
const JSON_INDENT = 2;

type PromptDigest = EvalRun["prompt_digests"][number];

export interface SuiteOptions {
  agent: string;
  repeat: number;
  cases: readonly string[];
  output: string;
  history: string;
  rerun: boolean;
  key: string;
  runtimeFactory?: WorkbenchModelRuntimeFactory;
  directory?: string;
  print?: (line: string) => void;
}

export interface Job {
  title: string;
  loaded: LoadedCase;
}

function printToStandardError(line: string): void {
  process.stderr.write(`${line}\n`);
}

function engineRevision(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: ENGINE_ROOT,
    encoding: "utf8",
  }).trim();
}

async function promptDigestsOf(sandbox: Sandbox): Promise<PromptDigest[]> {
  const agent = await sandbox.call(agentOperations.get, {
    params: { agent_name: sandbox.subject },
    query: {},
    body: null,
  });
  return (agent.prompt.parts ?? []).flatMap((part) =>
    part.state === PromptPartState.Resolved && part.digest !== null
      ? [{ layer: part.layer, source: part.name, digest: part.digest }]
      : [],
  );
}

function resultOf(played: PlayedCase, durationMs: number): RunResult {
  return {
    passed: played.score.passed,
    checks: played.score.checks,
    input_tokens: played.observation.usage.input,
    output_tokens: played.observation.usage.output,
    cost: played.observation.usage.cost,
    duration_ms: durationMs,
  };
}

function readHistory(path: string) {
  return existsSync(path)
    ? historySchema.parse(JSON.parse(readFileSync(path, "utf8")))
    : [];
}

function writeFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, JSON_INDENT)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  chmodSync(path, PRIVATE_FILE_MODE);
}

function passes(results: readonly RunResult[]): number {
  return results.filter((result) => result.passed).length;
}

function summaryLines(run: EvalRun): string[] {
  const { comparison } = run;
  return [
    ...run.cases.map((value) => {
      const verdict = casePassed(value) ? "PASS" : "FAIL";
      const rerun =
        value.rerun_pass_rate === null
          ? ""
          : ` rerun ${passes(value.reruns)}/${run.repeat}`;
      return `${verdict} ${value.case_id} ${passes(value.runs)}/${run.repeat}${rerun}`;
    }),
    `baseline ${comparison.baseline_run ?? "none"}`,
    ...comparison.regressed.map((id) => `regressed ${id}`),
    ...comparison.improved.map((id) => `improved ${id}`),
    ...comparison.new.map((id) => `new ${id}`),
    ...comparison.dropped.map((id) => `dropped ${id}`),
    `tokens_delta ${comparison.tokens_delta}`,
    `cost_delta ${comparison.cost_delta}`,
  ];
}

export class SuiteRun {
  readonly jobs: Job[];
  private readonly options: SuiteOptions;
  private readonly suite: LoadedCase[];
  private readonly results = new Map<string, RunResult[]>();
  private prompts: PromptDigest[] | null = null;

  constructor(options: SuiteOptions) {
    if (options.rerun && !options.cases.length)
      throw new CodedError(
        RunErrorCode.RerunCasesAbsent,
        "The rerun mode requires the variable EVAL_CASES.",
      );
    this.options = options;
    this.suite = loadSuite(options.agent, options.cases, options.directory);
    this.jobs = this.suite.flatMap((loaded) =>
      Array.from({ length: options.repeat }, (_, index) => ({
        title: `${loaded.id} ${index + 1}/${options.repeat}`,
        loaded,
      })),
    );
  }

  async play(t: TestContext, job: Job): Promise<void> {
    const sandbox = await openSandbox(t, {
      subject: this.options.agent,
      key: this.options.key,
      configuration: EVAL_CONFIGURATION,
      runtimeFactory: this.options.runtimeFactory,
      evalDirectory: this.options.directory,
    });
    if (!this.options.rerun && this.prompts === null)
      this.prompts = await promptDigestsOf(sandbox);
    const started = Date.now();
    const played = await playCase(sandbox, job.loaded);
    const results = this.results.get(job.loaded.id) ?? [];
    results.push(resultOf(played, Date.now() - started));
    this.results.set(job.loaded.id, results);
  }

  finish(): EvalRun {
    const history = readHistory(this.options.history);
    const run = evalRunSchema.parse(
      this.options.rerun ? this.rerunOf(history) : this.runOf(history),
    );
    writeFile(this.options.output, run);
    writeFile(this.entryPath(), historyEntryOf(run));
    const print = this.options.print ?? printToStandardError;
    for (const line of summaryLines(run)) print(line);
    return run;
  }

  private entryPath(): string {
    const { output } = this.options;
    return join(
      dirname(output),
      `${basename(output, RUN_EXTENSION)}${ENTRY_EXTENSION}`,
    );
  }

  private completeResults(loaded: LoadedCase): RunResult[] {
    const results = this.results.get(loaded.id) ?? [];
    if (results.length !== this.options.repeat)
      throw new CodedError(
        RunErrorCode.Incomplete,
        `The case ${loaded.id} holds ${results.length} of ${this.options.repeat} agent runs.`,
      );
    return results;
  }

  private runOf(history: ReturnType<typeof readHistory>): EvalRun {
    const { repeat } = this.options;
    const cases = this.suite.map((loaded) => {
      const runs = this.completeResults(loaded);
      return {
        case_id: loaded.id,
        case_digest: loaded.case_digest,
        pass_rate: passRateOf(runs, repeat),
        rerun_pass_rate: null,
        runs,
        reruns: [],
      };
    });
    return {
      run: basename(this.options.output, RUN_EXTENSION),
      subject: this.options.agent,
      engine_revision: engineRevision(),
      configuration: { ...EVAL_CONFIGURATION },
      prompt_digests: this.prompts ?? [],
      repeat,
      comparison: compare({ cases }, history),
      cases,
    };
  }

  private rerunOf(history: ReturnType<typeof readHistory>): EvalRun {
    const existing = evalRunSchema.parse(
      JSON.parse(readFileSync(this.options.output, "utf8")),
    );
    if (existing.repeat !== this.options.repeat)
      throw new CodedError(
        RunErrorCode.RerunRepeatChanged,
        "The variable EVAL_REPEAT differs from the repeat of the run file.",
      );
    const reruns: Record<string, RunResult[]> = {};
    for (const loaded of this.suite) {
      const known = existing.cases.find((value) => value.case_id === loaded.id);
      if (known?.case_digest !== loaded.case_digest)
        throw new CodedError(
          RunErrorCode.RerunCaseChanged,
          `The case ${loaded.id} differs from the case of the run file.`,
        );
      reruns[loaded.id] = this.completeResults(loaded);
    }
    const merged = mergeReruns(existing, reruns);
    return { ...merged, comparison: compare(merged, history) };
  }
}

export async function runSuite(
  t: TestContext,
  options: SuiteOptions,
): Promise<EvalRun> {
  const suite = new SuiteRun(options);
  for (const job of suite.jobs)
    await t.test(job.title, (subtest) => suite.play(subtest, job));
  return suite.finish();
}
