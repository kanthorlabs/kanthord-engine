import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../../kernel/context.ts";
import {
  DEVCONTAINER_FILE,
  parseEnvironmentText,
  setupScriptsOf,
  type Environment,
} from "../../kernel/devcontainer.ts";
import { ensureDirectory } from "../../kernel/files.ts";
import { canonicalJSON, digest } from "../../kernel/json.ts";
import { redactReason } from "../../kernel/probe.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { EnvironmentFailure } from "../../scheduler/contract.ts";
import type { ExecutionEnvironment } from "../contract.ts";
import { COMMAND_LIMIT_MS } from "./budget.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import {
  checkoutDetached,
  cloneLocal,
  commitOf,
  excludeUntracked,
  fileAtRevision,
  headCommit,
  restoreTracked,
  trackedChanges,
} from "./local-git.ts";
import {
  runVerificationsWithOutput,
  VerificationClass,
  type VerificationRun,
} from "./verification.ts";

export const SETUP_COMMAND_LIMIT_MS = COMMAND_LIMIT_MS;
export const BASE_DIRECTORY = "base";
const SINGLE_CHECKOUT = 1;
const NO_EXIT = -1;
const NO_DOCUMENT = "none";
const TRACKED_CHECK = "git status --porcelain --untracked-files=no";
const TRACKED_CHANGE_EXIT = 1;

export interface SetupRepository {
  binding_id: string;
  name: string;
  strategy: { base_branch: string };
  environment: ExecutionEnvironment;
}

export interface SetupCheckout {
  repository: SetupRepository;
  directory: string;
}

export interface SetupInput {
  env: NodeJS.ProcessEnv;
  context: Context;
  deadline: number;
  exhausted?: () => boolean;
}

export const SetupEnd = {
  Pass: "pass",
  BudgetEnd: "budget_end",
  Failed: "failed",
} as const;
export type SetupResult =
  | { end: typeof SetupEnd.Pass }
  | { end: typeof SetupEnd.BudgetEnd }
  | {
      end: typeof SetupEnd.Failed;
      run: VerificationRun;
      commands: readonly string[];
      changed?: readonly string[];
    };

function remaining(input: SetupInput): number {
  return Math.max(1, input.deadline - Date.now());
}

export type SetupFailure = Extract<
  SetupResult,
  { end: typeof SetupEnd.Failed }
>;

export function setupStop(result: SetupFailure): ExecutionStop {
  const last = result.run.verification.results.at(-1);
  return new ExecutionStop(
    EndReason.EnvironmentFailed,
    EnvironmentFailure.SetupFailed,
    redactReason(
      JSON.stringify(
        last === undefined
          ? { commands: result.commands }
          : {
              exit_code: last.exit_code,
              signal: last.signal,
              timed_out: last.timed_out,
              command: last.command,
              ...(result.changed === undefined
                ? {}
                : { changed_tracked_files: result.changed }),
            },
      ),
    ),
  );
}

function invalidEnvironment(reason: string): ExecutionStop {
  return new ExecutionStop(
    EndReason.EnvironmentFailed,
    EnvironmentFailure.SetupFailed,
    redactReason(`${DEVCONTAINER_FILE}: ${reason}`),
  );
}

export async function environmentOf(
  input: SetupInput,
  checkout: SetupCheckout,
): Promise<Environment | null> {
  const environment = checkout.repository.environment;
  if (environment === null) return null;
  if (environment.source !== EnvironmentSource.Repository)
    return environment.document;
  const text = await fileAtRevision(
    input.env,
    checkout.directory,
    `origin/${checkout.repository.strategy.base_branch}`,
    DEVCONTAINER_FILE,
    input.context,
    remaining(input),
  );
  if (text === null) return null;
  const parsed = parseEnvironmentText(text);
  if (parsed.document === null) throw invalidEnvironment(parsed.error);
  return parsed.document;
}

export function namedCheckouts(
  repositories: readonly SetupRepository[],
  checkouts: readonly { name: string; directory: string }[],
): SetupCheckout[] {
  return checkouts.map((checkout) => {
    const repository = repositories.find(
      (entry) => entry.name === checkout.name,
    );
    assert.ok(repository, "A checkout belongs to a repository of the setup.");
    return { repository, directory: checkout.directory };
  });
}

export interface SetupEntry {
  repository: SetupRepository;
  directory: string;
  environment: Environment | null;
}

export async function setupEntries(
  input: SetupInput,
  checkouts: readonly SetupCheckout[],
): Promise<SetupEntry[]> {
  const entries: SetupEntry[] = [];
  for (const checkout of checkouts)
    entries.push({
      ...checkout,
      environment: await environmentOf(input, checkout),
    });
  return entries;
}

function trackedFailure(
  run: VerificationRun,
  commands: readonly string[],
  changed: readonly string[],
): SetupFailure {
  return {
    end: SetupEnd.Failed,
    run: {
      ...run,
      verification: {
        ...run.verification,
        results: [
          ...run.verification.results,
          {
            command: TRACKED_CHECK,
            exit_code: TRACKED_CHANGE_EXIT,
            signal: null,
            timed_out: false,
          },
        ],
      },
      outputs: [
        ...run.outputs,
        `The setup changed these tracked files: ${changed.join(", ")}. KanthorD restored them. Commit a change so that the setup leaves every tracked file unchanged, for example the updated lock file.`,
      ],
      flaky: [...run.flaky, false],
      outcome: VerificationClass.CodeFailure,
    },
    commands: [...commands, TRACKED_CHECK],
    changed,
  };
}

export async function runSetup(
  input: SetupInput,
  entries: readonly SetupEntry[],
): Promise<SetupResult> {
  for (const entry of entries) {
    const commands =
      entry.environment === null ? [] : setupScriptsOf(entry.environment);
    if (!commands.length) continue;
    const run = await runVerificationsWithOutput({
      directory: entry.directory,
      commands,
      tested_input: {
        kind: "repository",
        binding_id: entry.repository.binding_id,
        commit: await headCommit(
          input.env,
          entry.directory,
          input.context,
          remaining(input),
        ),
      },
      deadline: input.deadline,
      context: input.context,
      env: input.env,
      commandLimitMs: SETUP_COMMAND_LIMIT_MS,
      exhausted: input.exhausted,
    });
    if (run.outcome === VerificationClass.BudgetEnd)
      return { end: SetupEnd.BudgetEnd };
    if (run.outcome !== VerificationClass.Pass) {
      await excludeUntracked(
        input.env,
        entry.directory,
        input.context,
        remaining(input),
      );
      return { end: SetupEnd.Failed, run, commands };
    }
    const changed = await trackedChanges(
      input.env,
      entry.directory,
      input.context,
      remaining(input),
    );
    if (changed.length)
      await restoreTracked(
        input.env,
        entry.directory,
        changed,
        input.context,
        remaining(input),
      );
    await excludeUntracked(
      input.env,
      entry.directory,
      input.context,
      remaining(input),
    );
    if (changed.length) return trackedFailure(run, commands, changed);
  }
  return { end: SetupEnd.Pass };
}

export class BaseHead {
  private readonly input: SetupInput;
  private readonly directory: string;
  private readonly checkouts: readonly SetupEntry[];
  private commitsRead: Promise<string[]> | null = null;
  private prepared: Promise<SetupResult> | null = null;
  private readonly results = new Map<string, number>();

  constructor(
    input: SetupInput,
    directory: string,
    checkouts: readonly SetupEntry[],
  ) {
    assert.ok(checkouts.length);
    this.input = input;
    this.directory = directory;
    this.checkouts = checkouts;
  }

  commits(): Promise<string[]> {
    this.commitsRead ??= Promise.all(
      this.checkouts.map((checkout) =>
        commitOf(
          this.input.env,
          checkout.directory,
          `origin/${checkout.repository.strategy.base_branch}`,
          this.input.context,
          remaining(this.input),
        ),
      ),
    );
    return this.commitsRead;
  }

  async holds(heads: readonly string[]): Promise<boolean> {
    const commits = await this.commits();
    return commits.every((commit, index) => commit === heads[index]);
  }

  setup(): Promise<SetupResult> {
    this.prepared ??= this.prepare();
    return this.prepared;
  }

  async exitOf(command: string): Promise<number | null> {
    const key = canonicalJSON({
      commits: await this.commits(),
      digests: this.digests(),
      command,
    });
    const known = this.results.get(key);
    if (known !== undefined) return known;
    const setup = await this.setup();
    if (setup.end === SetupEnd.Failed) throw setupStop(setup);
    if (setup.end === SetupEnd.BudgetEnd) return null;
    const run = await runVerificationsWithOutput({
      directory: this.root(),
      commands: [command],
      tested_input: { kind: "produced", sha256: digest(key) },
      deadline: this.input.deadline,
      context: this.input.context,
      env: this.input.env,
      exhausted: this.input.exhausted,
    });
    if (run.outcome === VerificationClass.BudgetEnd) return null;
    const exit = run.verification.results[0]?.exit_code ?? NO_EXIT;
    this.results.set(key, exit);
    return exit;
  }

  dispose(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }

  private root(): string {
    return this.checkouts.length === SINGLE_CHECKOUT
      ? join(this.directory, this.checkouts[0]!.repository.name)
      : this.directory;
  }

  private digests(): string[] {
    return this.checkouts.map((checkout) =>
      checkout.environment === null
        ? NO_DOCUMENT
        : digest(checkout.environment),
    );
  }

  private async prepare(): Promise<SetupResult> {
    const commits = await this.commits();
    rmSync(this.directory, { recursive: true, force: true });
    ensureDirectory(this.directory);
    const clones: SetupEntry[] = [];
    for (const [index, checkout] of this.checkouts.entries()) {
      const directory = join(this.directory, checkout.repository.name);
      await cloneLocal(
        this.input.env,
        checkout.directory,
        directory,
        this.input.context,
        remaining(this.input),
      );
      await checkoutDetached(
        this.input.env,
        directory,
        commits[index]!,
        this.input.context,
        remaining(this.input),
      );
      clones.push({ ...checkout, directory });
    }
    return runSetup(this.input, clones);
  }
}

export async function setUpHeads(
  input: SetupInput,
  entries: readonly SetupEntry[],
  base: BaseHead,
  heads: readonly string[],
): Promise<SetupResult> {
  const result = await runSetup(input, entries);
  if (result.end !== SetupEnd.Failed) return result;
  if (await base.holds(heads)) throw setupStop(result);
  const baseResult = await base.setup();
  if (baseResult.end === SetupEnd.Failed) throw setupStop(baseResult);
  if (baseResult.end === SetupEnd.BudgetEnd) return baseResult;
  return result;
}
