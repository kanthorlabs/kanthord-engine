import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { simpleGit } from "simple-git";
import { childEnvironment } from "../../agent/environment.ts";
import type { Context } from "../../kernel/context.ts";
import { CodedError } from "../../kernel/errors.ts";
import {
  GIT_UNSAFE_OPTIONS,
  isolatedGitEnvironment,
} from "../../kernel/git-environment.ts";
import { RepositoryErrorCode } from "../../repository/contract.ts";
import type { ExecutionSetup } from "../contract.ts";
import type { NodeWorkspace } from "./chain.ts";
import type { ExecutionRun } from "./execution-run.ts";
import {
  type CheckoutRef,
  type CommandTree,
  type PortCall,
  type PortResult,
  PortResultKind,
  type ReleaseTreePort,
  type RepositoryPort,
  TreeSource,
} from "./foundry-ports.ts";
import {
  checkoutDetached,
  clonePacked,
  fetchLocal,
  matchCheckoutRefs,
  matchOriginHead,
  matchRemote,
  removeBranches,
  resolveGitPaths,
} from "./local-git.ts";
import { GitStep, withinGit } from "./method-telemetry.ts";
import { mergedBranchesOf } from "./setup-repository.ts";
import { tasksDiagnostic, TasksErrorCode } from "./tasks-seed.ts";
import { excludeScratch } from "./workspace.ts";
import {
  BASE_DIRECTORY,
  CHECKOUTS_DIRECTORY,
  type NodeCheckout,
  RELEASE_DIRECTORY,
} from "./workspace-layout.ts";

export const ORIGIN_DIRECTORY = "origin";
const MIRROR_SUFFIX = ".git";
const PUSH_REFUSED_SUFFIX = ".push-refused";
const SINGLE_CHECKOUT = 1;
const MIN_DEADLINE_MS = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LOCKED_DIRECTORY_MODE = 0o500;
const LOCKED_FILE_MODE = 0o400;

interface TreeModes {
  directory: number;
  file: number;
}

const LOCKED: TreeModes = {
  directory: LOCKED_DIRECTORY_MODE,
  file: LOCKED_FILE_MODE,
};
const UNLOCKED: TreeModes = {
  directory: PRIVATE_DIRECTORY_MODE,
  file: PRIVATE_FILE_MODE,
};

function chmodTree(path: string, modes: TreeModes): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) return chmodSync(path, modes.file);
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
  for (const entry of readdirSync(path)) chmodTree(join(path, entry), modes);
  chmodSync(path, modes.directory);
}

export function unlockTree(path: string): void {
  if (existsSync(path)) chmodTree(path, UNLOCKED);
}

export interface LocalGitCall {
  env: NodeJS.ProcessEnv;
  context: Context;
  deadline: number;
}

export interface LocalTrees {
  workspace: NodeWorkspace;
  mirrors: ReadonlyMap<string, string>;
}

interface TreeSources {
  state: string;
  setup: ExecutionSetup;
  nodeBranch: string;
  sources: ReadonlyMap<string, string>;
  heads: Readonly<Record<string, string>>;
}

function remaining(deadline: number): number {
  return Math.max(MIN_DEADLINE_MS, deadline - Date.now());
}

export async function localGit(
  directory: string,
  args: string[],
  call: LocalGitCall,
): Promise<string> {
  call.context.signal.throwIfAborted();
  try {
    return await simpleGit({
      baseDir: directory,
      abort: call.context.signal,
      timeout: { block: remaining(call.deadline) },
      unsafe: GIT_UNSAFE_OPTIONS,
    })
      .env(isolatedGitEnvironment(childEnvironment(call.env)))
      .raw(args);
  } catch (error) {
    throw new CodedError(
      RepositoryErrorCode.GitFailed,
      "A local git call failed.",
      {
        cause: error,
      },
    );
  }
}

function mirrorOf(state: string, bindingId: string): string {
  return join(state, ORIGIN_DIRECTORY, `${bindingId}${MIRROR_SUFFIX}`);
}

async function treeChecked(
  work: () => Promise<void>,
  bindingId: string,
): Promise<void> {
  try {
    await work();
  } catch {
    throw tasksDiagnostic(
      TasksErrorCode.TreeInvalid,
      "worker tasks run: a tree source is no git repository, or its clone lacks the seed head or the base branch.",
      [["binding", bindingId]],
    );
  }
}

async function prepareCheckout(
  input: TreeSources,
  repository: ExecutionSetup["repositories"][number],
  call: LocalGitCall,
): Promise<NodeCheckout> {
  const { binding_id, name } = repository;
  const mirror = mirrorOf(input.state, binding_id);
  const directory = join(input.state, CHECKOUTS_DIRECTORY, name);
  const head = input.heads[binding_id];
  await treeChecked(async () => {
    if (head === undefined) throw new Error("absent head");
    const source = input.sources.get(binding_id);
    if (source === undefined) throw new Error("absent source");
    await localGit(
      dirname(mirror),
      ["clone", "--mirror", "--no-local", "--", source, mirror],
      call,
    );
    await localGit(mirror, ["remote", "remove", "origin"], call);
    await localGit(
      dirname(directory),
      ["clone", "--no-local", "--no-checkout", "--", mirror, directory],
      call,
    );
    await localGit(
      directory,
      ["rev-parse", "--verify", `${head}^{commit}`],
      call,
    );
    await localGit(
      directory,
      [
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${repository.strategy.base_branch}`,
      ],
      call,
    );
    await localGit(
      directory,
      ["checkout", "--force", "-B", input.nodeBranch, head, "--"],
      call,
    );
    await localGit(
      directory,
      ["config", "remote.origin.pushurl", `${mirror}${PUSH_REFUSED_SUFFIX}`],
      call,
    );
    chmodTree(mirror, LOCKED);
  }, binding_id);
  excludeScratch(directory);
  const gitPaths = await resolveGitPaths({
    env: call.env,
    directory,
    context: call.context,
    deadlineMs: remaining(call.deadline),
  });
  return { binding_id, name, directory, head: head!, gitPaths };
}

export async function prepareTrees(
  input: TreeSources,
  call: LocalGitCall,
): Promise<LocalTrees> {
  for (const directory of [ORIGIN_DIRECTORY, CHECKOUTS_DIRECTORY])
    mkdirSync(join(input.state, directory), {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
  const checkouts: NodeCheckout[] = [];
  for (const repository of input.setup.repositories)
    checkouts.push(await prepareCheckout(input, repository, call));
  return {
    workspace: {
      root:
        checkouts.length > SINGLE_CHECKOUT
          ? join(input.state, CHECKOUTS_DIRECTORY)
          : checkouts[0]!.directory,
      checkouts,
    },
    mirrors: new Map(
      input.setup.repositories.map(({ binding_id }) => [
        binding_id,
        mirrorOf(input.state, binding_id),
      ]),
    ),
  };
}

interface LocalTreeHost {
  state: string;
  setup: ExecutionSetup;
  env: NodeJS.ProcessEnv;
  run: ExecutionRun;
}

function ok<T>(value: T): PortResult<T> {
  return { kind: PortResultKind.Ok, value };
}

export function localRepositoryPort(host: LocalTreeHost): RepositoryPort {
  return {
    async fetchBase(checkout, call) {
      const git = {
        env: host.env,
        context: call.context,
        deadline: call.deadline,
      };
      try {
        for (const branch of mergedBranchesOf({ input: host }, checkout))
          await withinGit(host.run.spans, GitStep.FetchBase, async () => {
            await localGit(
              checkout.directory,
              ["check-ref-format", "--branch", branch],
              git,
            );
            await localGit(
              checkout.directory,
              ["fetch", "--prune", "origin"],
              git,
            );
            await localGit(
              checkout.directory,
              ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
              git,
            );
          });
        return ok(null);
      } catch (error) {
        return host.run.failureOf(error);
      }
    },
  };
}

function gitCallOf(host: LocalTreeHost, directory: string, call: PortCall) {
  return {
    env: host.env,
    directory,
    context: call.context,
    deadlineMs: remaining(call.deadline),
  };
}

async function takenTree(
  host: LocalTreeHost,
  tree: CommandTree,
  build: () => Promise<void>,
): Promise<PortResult<CommandTree>> {
  rmSync(tree.directory, { recursive: true, force: true });
  mkdirSync(dirname(tree.directory), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  });
  try {
    await build();
    return ok(tree);
  } catch (error) {
    rmSync(tree.directory, { recursive: true, force: true });
    return host.run.failureOf(error);
  }
}

function treeDirectory(
  host: LocalTreeHost,
  place: string,
  checkout: CheckoutRef,
): string {
  return join(
    host.state,
    place,
    relative(join(host.state, CHECKOUTS_DIRECTORY), checkout.directory),
  );
}

export function localReleaseTreePort(host: LocalTreeHost): ReleaseTreePort {
  const give = async (tree: CommandTree) =>
    rmSync(tree.directory, { recursive: true, force: true });
  return {
    take(checkout, head, call) {
      const directory = treeDirectory(host, RELEASE_DIRECTORY, checkout);
      const git = () => gitCallOf(host, directory, call);
      const mirror = mirrorOf(host.state, checkout.binding_id);
      return takenTree(
        host,
        {
          binding_id: checkout.binding_id,
          directory,
          source: TreeSource.Clone,
        },
        async () => {
          await clonePacked(git(), checkout.directory);
          await fetchLocal(git(), checkout.directory);
          await matchRemote(
            host.env,
            directory,
            checkout.directory,
            mirror,
            call.context,
            remaining(call.deadline),
          );
          await matchOriginHead(git(), checkout.directory);
          await checkoutDetached(
            host.env,
            directory,
            head,
            call.context,
            remaining(call.deadline),
          );
          await removeBranches(git());
        },
      );
    },
    takeBase(checkout, commit, call) {
      const directory = treeDirectory(host, BASE_DIRECTORY, checkout);
      const git = () => gitCallOf(host, directory, call);
      const mirror = mirrorOf(host.state, checkout.binding_id);
      return takenTree(
        host,
        {
          binding_id: checkout.binding_id,
          directory,
          source: TreeSource.Clone,
        },
        async () => {
          await clonePacked(git(), checkout.directory);
          await fetchLocal(git(), checkout.directory);
          await checkoutDetached(
            host.env,
            directory,
            commit,
            call.context,
            remaining(call.deadline),
          );
          await matchCheckoutRefs(git(), checkout.directory, mirror);
        },
      );
    },
    give,
    giveBase: give,
  };
}
