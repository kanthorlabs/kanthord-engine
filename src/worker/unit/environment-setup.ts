import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../../kernel/context.ts";
import {
  DEVCONTAINER_FILE,
  type Environment,
  parseEnvironmentText,
  setupScriptsOf,
} from "../../kernel/devcontainer.ts";
import { ensureDirectory } from "../../kernel/files.ts";
import { canonicalJSON, digest } from "../../kernel/json.ts";
import { redactReason } from "../../kernel/probe.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { EnvironmentFailure } from "../../scheduler/contract.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import type { ExecutionEnvironment } from "../contract.ts";
import { COMMAND_LIMIT_MS } from "./budget.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import {
  checkoutDetached,
  cloneLocal,
  clonePacked,
  commitOf,
  excludeUntracked,
  fetchLocal,
  fileAtRevision,
  type GitCall,
  headCommit,
  ignoredPaths,
  matchCheckoutRefs,
  restoreTracked,
  scrubTree,
  trackedChanges,
} from "./local-git.ts";
import {
  nextRoots,
  readSetupRecord,
  removeSetupRecord,
  writeSetupRecord,
} from "./setup-record.ts";
import { SpanOperation, type SpanRecorder } from "./telemetry.ts";
import { PoolClass, prepareTree } from "./tree-pool.ts";
import {
  type CommandObserver,
  runVerificationsWithOutput,
  VerificationClass,
  type VerificationRun,
} from "./verification.ts";
import type { WorkspaceRoot } from "./workspace.ts";

export const SETUP_COMMAND_LIMIT_MS = COMMAND_LIMIT_MS;
const SINGLE_CHECKOUT = 1;
const NO_EXIT = -1;
const MISSING_INDEX = -1;
const NO_DOCUMENT = "none";
const TRACKED_CHECK = "git status --porcelain --untracked-files=no";
const TRACKED_CHANGE_EXIT = 1;
const SETUP_ENTRY_COUNT = "kanthord.setup.entry_count";
const SETUP_RESULT = "kanthord.setup.result";
const TREE_PREPARED = "tree prepared";
const TREE_DELETED = "tree deleted";
const BASE_PURPOSE = "base";
const UNKNOWN_ERROR = "unknown";
const NO_REFS: readonly string[] = [];

export interface SetupRepository {
  binding_id: string;
  name: string;
  strategy: { base_branch: string; upstream_branch?: string };
  environment: ExecutionEnvironment;
}

export interface SetupCheckout {
  repository: SetupRepository;
  directory: string;
}

export interface BaseRunInput {
  command: string;
  variables: Readonly<Record<string, string>>;
  commandLimitMs: number;
  observe?: CommandObserver;
}

export interface BaseTrees {
  workspaces: WorkspaceRoot;
  nodeId: string;
  addresses: ReadonlyMap<string, string>;
  log: (msg: string, fields: Record<string, unknown>) => void;
}

export interface BasePlace {
  directory: string;
  trees?: BaseTrees;
}

export interface SetupInput {
  env: NodeJS.ProcessEnv;
  context: Context;
  deadline: number;
  spans: SpanRecorder | null;
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

export function environmentDigestOf(entry: SetupEntry): string {
  return entry.environment === null ? NO_DOCUMENT : digest(entry.environment);
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
      flaky_failures: run.flaky_failures,
      outcome: VerificationClass.CodeFailure,
    },
    commands: [...commands, TRACKED_CHECK],
    changed,
  };
}

export function runSetup(
  input: SetupInput,
  entries: readonly SetupEntry[],
): Promise<SetupResult> {
  if (input.spans === null) return setUpEntries(input, entries);
  return input.spans.within(
    {
      key: input.spans.key(SpanOperation.Setup),
      operation: SpanOperation.Setup,
      attributes: {
        [SETUP_ENTRY_COUNT]: entries.filter(
          (entry) =>
            entry.environment !== null &&
            setupScriptsOf(entry.environment).length,
        ).length,
      },
    },
    () => setUpEntries(input, entries),
    (result) => ({
      status: SpanStatus.Ok,
      attributes: { [SETUP_RESULT]: result.end },
    }),
  );
}

async function keptRoots(
  call: GitCall,
  environmentDigest: string,
): Promise<string[]> {
  const record = await readSetupRecord(call);
  if (record === null) return [];
  if (record.digest === environmentDigest) return record.roots;
  for (const root of record.roots)
    rmSync(join(call.directory, root), { recursive: true, force: true });
  removeSetupRecord(call.directory);
  return [];
}

function gitCall(input: SetupInput, entry: SetupEntry): GitCall {
  return {
    env: input.env,
    directory: entry.directory,
    context: input.context,
    deadlineMs: remaining(input),
  };
}

async function setUpEntries(
  input: SetupInput,
  entries: readonly SetupEntry[],
): Promise<SetupResult> {
  for (const entry of entries) {
    const environmentDigest = environmentDigestOf(entry);
    const kept = await keptRoots(gitCall(input, entry), environmentDigest);
    const commands =
      entry.environment === null ? [] : setupScriptsOf(entry.environment);
    if (!commands.length) continue;
    const before = await ignoredPaths(gitCall(input, entry));
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
    writeSetupRecord(entry.directory, {
      digest: environmentDigest,
      roots: nextRoots(kept, before, await ignoredPaths(gitCall(input, entry))),
    });
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
  private readonly trees: BaseTrees | null;

  constructor(
    input: SetupInput,
    place: BasePlace,
    checkouts: readonly SetupEntry[],
  ) {
    assert.ok(checkouts.length);
    this.input = input;
    this.directory = place.directory;
    this.checkouts = checkouts;
    this.trees = place.trees ?? null;
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

  async commitOf(name: string): Promise<string> {
    const commits = await this.commits();
    const index = this.checkouts.findIndex(
      (checkout) => checkout.repository.name === name,
    );
    assert.notEqual(
      index,
      MISSING_INDEX,
      "A name belongs to a checkout of the base head.",
    );
    return commits[index]!;
  }

  async runIn(
    name: string,
    input: BaseRunInput,
  ): Promise<VerificationRun | null> {
    const checkout = this.checkouts.find(
      (entry) => entry.repository.name === name,
    );
    assert.ok(checkout, "A name belongs to a checkout of the base head.");
    const setup = await this.setup();
    if (setup.end === SetupEnd.Failed) throw setupStop(setup);
    if (setup.end === SetupEnd.BudgetEnd) return null;
    const run = await runVerificationsWithOutput({
      directory: join(this.directory, name),
      commands: [input.command],
      variables: input.variables,
      commandLimitMs: input.commandLimitMs,
      observe: input.observe,
      tested_input: {
        kind: "repository",
        binding_id: checkout.repository.binding_id,
        commit: await this.commitOf(name),
      },
      deadline: this.input.deadline,
      context: this.input.context,
      env: this.input.env,
      exhausted: this.input.exhausted,
    });
    return run.outcome === VerificationClass.BudgetEnd ? null : run;
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

  async giveBack(): Promise<void> {
    if (this.prepared === null) return;
    await this.prepared.catch(() => null);
    if (this.trees === null) {
      rmSync(this.directory, { recursive: true, force: true });
      return;
    }
    const { workspaces, nodeId, log } = this.trees;
    for (const checkout of this.checkouts)
      workspaces.giveTree(
        {
          address: this.addressOf(checkout),
          poolClass: PoolClass.Command,
        },
        join(this.directory, checkout.repository.name),
        { nodeId, log },
      );
    try {
      workspaces.removeSafely(this.directory);
    } catch (error) {
      log(TREE_DELETED, {
        path: this.directory,
        code:
          (error as NodeJS.ErrnoException | undefined)?.code ?? UNKNOWN_ERROR,
      });
    }
  }

  private addressOf(checkout: SetupEntry): string {
    const address = this.trees?.addresses.get(checkout.repository.name);
    assert.ok(address, "A checkout of the base head holds an address.");
    return address;
  }

  private root(): string {
    return this.checkouts.length === SINGLE_CHECKOUT
      ? join(this.directory, this.checkouts[0]!.repository.name)
      : this.directory;
  }

  private digests(): string[] {
    return this.checkouts.map(environmentDigestOf);
  }

  private async prepare(): Promise<SetupResult> {
    const commits = await this.commits();
    if (this.trees !== null) return this.prepareTrees(this.trees, commits);
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

  private async prepareTrees(
    trees: BaseTrees,
    commits: readonly string[],
  ): Promise<SetupResult> {
    const { env, context } = this.input;
    await trees.workspaces.giveLeftoverTrees(
      this.directory,
      {
        env,
        context,
        nodeId: trees.nodeId,
        repositories: this.checkouts.map((checkout) => ({
          name: checkout.repository.name,
          address: this.addressOf(checkout),
        })),
        poolClass: PoolClass.Command,
        log: trees.log,
      },
      performance.now() + remaining(this.input),
    );
    ensureDirectory(this.directory);
    const clones: SetupEntry[] = [];
    for (const [index, checkout] of this.checkouts.entries()) {
      const directory = join(this.directory, checkout.repository.name);
      const commit = commits[index]!;
      const address = this.addressOf(checkout);
      const call = () => ({
        env,
        directory,
        context,
        deadlineMs: remaining(this.input),
      });
      const { source } = await prepareTree({
        pool: trees.workspaces.pool,
        address,
        poolClass: PoolClass.Command,
        target: directory,
        nodeId: trees.nodeId,
        keepRefs: NO_REFS,
        env,
        context,
        deadlineMs: remaining(this.input),
        fresh: async () => {
          await clonePacked(call(), checkout.directory);
          await fetchLocal(call(), checkout.directory);
          await checkoutDetached(
            env,
            directory,
            commit,
            context,
            remaining(this.input),
          );
          await matchCheckoutRefs(call(), checkout.directory, address);
        },
        reuse: async () => {
          await fetchLocal(call(), checkout.directory);
          const record = await readSetupRecord(call());
          await scrubTree(call(), commit, record?.roots ?? []);
          await matchCheckoutRefs(call(), checkout.directory, address);
        },
      });
      trees.log(TREE_PREPARED, { purpose: BASE_PURPOSE, source });
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
