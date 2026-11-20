import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ensureDirectory } from "../../kernel/files.ts";
import type { ExecutionBudget } from "./budget.ts";
import type { ExecutionRun } from "./execution-run.ts";
import {
  type AgentOpenRequest,
  type AgentPort,
  type AgentSession,
  type CheckoutRef,
  type CommandTree,
  type CommonPorts,
  type DependencyPort,
  type EvaluationPorts,
  type EvidencePort,
  type ExaminePorts,
  type ImplementHostPorts,
  type ImplementPorts,
  type PortResult,
  PortResultKind,
  type ReleaseTreePort,
  type RepositoryPort,
  type UnitRecordPort,
} from "./foundry-ports.ts";
import {
  checkoutDetached,
  clonePacked,
  fetchLocal,
  matchCheckoutRefs,
  matchOriginHead,
  matchRemote,
  removeBranches,
  scrubTree,
} from "./local-git.ts";
import { GitStep, withinGit } from "./method-telemetry.ts";
import type { NativeAgent } from "./native-agent-session.ts";
import { readDependencies } from "./node-reads.ts";
import { readSetupRecord } from "./setup-record.ts";
import { endedByBudget } from "./step-support.ts";
import { mergedBranchesOf, repositoryOf } from "./setup-repository.ts";
import type { HostInput } from "./chain-host.ts";
import { PoolClass, prepareTree } from "./tree-pool.ts";
import {
  type LeftoverRepository,
  sshAccessOf,
  type WorkspaceRoot,
} from "./workspace.ts";
import {
  BASE_DIRECTORY,
  CHECKOUTS_DIRECTORY,
  RELEASE_DIRECTORY,
} from "./workspace-layout.ts";

const NO_REFS: readonly string[] = [];
const NO_TREES = 0;
const MIN_DEADLINE_MS = 1;
const PARENT = "..";
const TREE_DELETED = "tree deleted";
const UNKNOWN_ERROR = "unknown";

type FailureMapper = Pick<ExecutionRun, "failureOf">;

export interface BaseTreeHost {
  workspaces: WorkspaceRoot;
  nodeId: string;
  env: NodeJS.ProcessEnv;
  repositories: readonly LeftoverRepository[];
  addressOf: (checkout: Pick<CheckoutRef, "binding_id">) => string;
  log: (msg: string, fields: Record<string, unknown>) => void;
  run: FailureMapper;
}

export type BaseTreePort = Pick<ReleaseTreePort, "takeBase" | "giveBase">;

function ok<T>(value: T): PortResult<T> {
  return { kind: PortResultKind.Ok, value };
}

function evidencePort(run: ExecutionRun): EvidencePort {
  return {
    async submit(draft, _context, options) {
      if (!options.halt) {
        const answer = await run.callNoHalt((clientOptions) =>
          run.clients.mission["evidence.submit"](
            {
              params: { node_id: run.claim.node_id },
              query: {},
              body: { ...draft, ...run.context() },
            },
            clientOptions,
          ),
        );
        return answer.kind === PortResultKind.Ok
          ? ok(answer.value.evidence.id)
          : answer;
      }
      try {
        return ok((await run.submitEvidence(run.claim.node_id, draft)).id);
      } catch (error) {
        return run.failureOf(error);
      }
    },
  };
}

function repositoryPort(input: HostInput, run: ExecutionRun): RepositoryPort {
  return {
    async fetchBase(checkout, call) {
      try {
        for (const branch of mergedBranchesOf({ input }, checkout))
          await withinGit(run.spans, GitStep.FetchBase, () =>
            input.transport.fetchBase(
              checkout.directory,
              branch,
              call.context,
              call.deadline - Date.now(),
              sshAccessOf(input.sshAccess, checkout.binding_id),
            ),
          );
        return ok(null);
      } catch (error) {
        return run.failureOf(error);
      }
    },
  };
}

function layoutOf(checkouts: string, directory: string): string {
  const path = relative(checkouts, directory);
  assert.ok(!path.startsWith(PARENT) && !isAbsolute(path));
  return path;
}

export function baseTreePort(host: BaseTreeHost): BaseTreePort {
  const { workspaces, nodeId, env, log } = host;
  const base = join(workspaces.nodeKey(nodeId), BASE_DIRECTORY);
  const held = new Set<string>();
  const owner = { nodeId, log };
  const give = (tree: Pick<CommandTree, "binding_id" | "directory">) => {
    held.delete(tree.directory);
    workspaces.giveTree(
      { address: host.addressOf(tree), poolClass: PoolClass.Command },
      tree.directory,
      owner,
    );
    if (held.size > NO_TREES) return;
    try {
      workspaces.removeSafely(base);
    } catch (error) {
      log(TREE_DELETED, {
        path: base,
        code:
          (error as NodeJS.ErrnoException | undefined)?.code ?? UNKNOWN_ERROR,
      });
    }
  };
  return {
    async takeBase(checkout, commit, call) {
      const { context } = call;
      const directory = join(base, checkout.name);
      const address = host.addressOf(checkout);
      const remaining = () =>
        Math.max(MIN_DEADLINE_MS, call.deadline - Date.now());
      const git = () => ({ env, directory, context, deadlineMs: remaining() });
      try {
        if (held.size === NO_TREES) {
          await workspaces.giveLeftoverTrees(
            base,
            {
              env,
              context,
              nodeId,
              repositories: host.repositories,
              poolClass: PoolClass.Command,
              log,
            },
            performance.now() + remaining(),
          );
          ensureDirectory(base);
        }
        held.add(directory);
        const { source } = await prepareTree({
          pool: workspaces.pool,
          address,
          poolClass: PoolClass.Command,
          target: directory,
          nodeId,
          keepRefs: NO_REFS,
          env,
          context,
          deadlineMs: remaining(),
          fresh: async () => {
            await clonePacked(git(), checkout.directory);
            await fetchLocal(git(), checkout.directory);
            await checkoutDetached(
              env,
              directory,
              commit,
              context,
              remaining(),
            );
            await matchCheckoutRefs(git(), checkout.directory, address);
          },
          reuse: async () => {
            await fetchLocal(git(), checkout.directory);
            const record = await readSetupRecord(git());
            await scrubTree(git(), commit, record?.roots ?? []);
            await matchCheckoutRefs(git(), checkout.directory, address);
          },
        });
        return ok({ binding_id: checkout.binding_id, directory, source });
      } catch (error) {
        give({ ...checkout, directory });
        return host.run.failureOf(error);
      }
    },
    async giveBase(tree) {
      give(tree);
    },
  };
}

function releaseTreePort(input: HostInput, run: ExecutionRun): ReleaseTreePort {
  const { workspaces } = input;
  const nodeId = input.claim.node_id;
  const key = workspaces.nodeKey(nodeId);
  const base = join(key, RELEASE_DIRECTORY);
  const checkouts = join(key, CHECKOUTS_DIRECTORY);
  const taken = new Set<string>();
  const owner = {
    nodeId,
    log: (msg: string, fields: Record<string, unknown>) => run.log(msg, fields),
  };
  const addressOf = (checkout: Pick<CheckoutRef, "binding_id">) =>
    repositoryOf({ input }, checkout).address;
  const clearBase = () => {
    workspaces.removeUnreal(base);
    ensureDirectory(base);
    const current = new Set(
      input.setup.repositories.map(({ name }) =>
        layoutOf(checkouts, workspaces.nodeDirectory(nodeId, name)),
      ),
    );
    for (const name of readdirSync(base))
      if (!current.has(name))
        rmSync(join(base, name), { recursive: true, force: true });
  };
  const giveBack = (binding: Pick<CheckoutRef, "binding_id">, tree: string) => {
    taken.delete(tree);
    workspaces.giveTree(
      { address: addressOf(binding), poolClass: PoolClass.Command },
      tree,
      owner,
    );
    if (taken.size === NO_TREES) workspaces.removeSafely(base);
  };
  return {
    async take(checkout, head, call) {
      const directory = join(base, layoutOf(checkouts, checkout.directory));
      const address = addressOf(checkout);
      const { env } = input;
      const { context } = call;
      const remaining = () => call.deadline - Date.now();
      const git = () => ({ env, directory, context, deadlineMs: remaining() });
      try {
        if (taken.size === NO_TREES) clearBase();
        rmSync(directory, { recursive: true, force: true });
        const { source } = await prepareTree({
          pool: workspaces.pool,
          address,
          poolClass: PoolClass.Command,
          target: directory,
          nodeId,
          keepRefs: NO_REFS,
          env,
          context,
          deadlineMs: remaining(),
          fresh: async () => {
            await clonePacked(git(), checkout.directory);
            await fetchLocal(git(), checkout.directory);
            await matchRemote(
              env,
              directory,
              checkout.directory,
              address,
              context,
              remaining(),
            );
            await matchOriginHead(git(), checkout.directory);
            await checkoutDetached(env, directory, head, context, remaining());
            await removeBranches(git());
          },
          reuse: async () => {
            await matchRemote(
              env,
              directory,
              checkout.directory,
              address,
              context,
              remaining(),
            );
            await matchOriginHead(git(), checkout.directory);
            await fetchLocal(git(), checkout.directory);
            const record = await readSetupRecord(git());
            await scrubTree(git(), head, record?.roots ?? []);
          },
        });
        taken.add(directory);
        return ok({ binding_id: checkout.binding_id, directory, source });
      } catch (error) {
        giveBack(checkout, directory);
        return run.failureOf(error);
      }
    },
    ...baseTreePort({
      workspaces,
      nodeId,
      env: input.env,
      repositories: input.setup.repositories,
      addressOf,
      log: owner.log,
      run,
    }),
    async give(tree) {
      giveBack(tree, tree.directory);
    },
  };
}

export type AgentOpener = (request: AgentOpenRequest) => Promise<NativeAgent>;

export interface AgentHost {
  run: ExecutionRun;
  budget: ExecutionBudget;
  open: AgentOpener;
}

async function openedNode(
  host: AgentHost,
  request: AgentOpenRequest,
): Promise<PortResult<AgentSession>> {
  try {
    return ok(await host.open(request));
  } catch (error) {
    return host.run.failureOf(error);
  }
}

export function agentOpenPort(host: AgentHost): AgentPort {
  return {
    async open(request) {
      if (request.reviewWorkspace === null) return openedNode(host, request);
      try {
        return ok(await host.open(request));
      } catch (error) {
        if (
          endedByBudget(
            { budget: host.budget, context: host.run.operationContext },
            error,
          )
        )
          return { kind: PortResultKind.BudgetEnd };
        return host.run.failureOf(error);
      }
    },
  };
}

function unitRecordPort(run: ExecutionRun): UnitRecordPort {
  return {
    async put(record) {
      const answer = await run.callNoHalt((clientOptions) =>
        run.clients.worker["execution.unit_record.put"](
          {
            params: { execution_id: run.claim.execution_id },
            query: {},
            body: record,
          },
          clientOptions,
        ),
      );
      return answer.kind === PortResultKind.Ok ? ok(null) : answer;
    },
  };
}

export function commonPorts(run: ExecutionRun): CommonPorts {
  return {
    telemetry: run.spans,
    secrets: { redact: (text) => run.redact(text) },
    log: { log: (message, fields) => run.log(message, fields) },
  };
}

function dependencyPort(host: AgentHost): DependencyPort {
  return {
    async read() {
      try {
        return ok(await readDependencies(host.run));
      } catch (error) {
        if (
          endedByBudget(
            { budget: host.budget, context: host.run.operationContext },
            error,
          )
        )
          return { kind: PortResultKind.BudgetEnd };
        return host.run.failureOf(error);
      }
    },
  };
}

export function evaluationPorts(host: AgentHost): EvaluationPorts {
  return {
    ...commonPorts(host.run),
    evidence: evidencePort(host.run),
    agent: agentOpenPort(host),
    dependencies: dependencyPort(host),
  };
}

export function examinePorts(host: AgentHost): ExaminePorts {
  return {
    ...commonPorts(host.run),
    evidence: evidencePort(host.run),
    agent: agentOpenPort(host),
    dependencies: dependencyPort(host),
  };
}

export function implementHostPorts(
  input: HostInput,
  host: AgentHost,
): ImplementHostPorts {
  return { ...workerPorts(input, host.run), agent: agentOpenPort(host) };
}

export function workerPorts(
  input: HostInput,
  run: ExecutionRun,
): ImplementPorts {
  return {
    ...commonPorts(run),
    evidence: evidencePort(run),
    repository: repositoryPort(input, run),
    releaseTrees: releaseTreePort(input, run),
    unitRecords: unitRecordPort(run),
  };
}
