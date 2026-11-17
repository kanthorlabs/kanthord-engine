import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { ensureDirectory } from "../../kernel/files.ts";
import { mergedBranchesOf } from "./base-refresh.ts";
import type { ExecutionBudget } from "./budget.ts";
import type { ExecutionRun } from "./execution-run.ts";
import {
  type AgentPort,
  type CheckoutRef,
  type CommonPorts,
  type EvaluationPorts,
  type EvidencePort,
  type ExaminePorts,
  type ImplementPorts,
  type PortResult,
  PortResultKind,
  type ReleaseTreePort,
  type RepositoryPort,
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
import type { NativeAgent } from "./native-agent.ts";
import { readSetupRecord } from "./setup-record.ts";
import { endedByBudget } from "./step-support.ts";
import { repositoryOf, type StepsInput } from "./steps-implement.ts";
import { PoolClass, prepareTree } from "./tree-pool.ts";
import {
  BASE_DIRECTORY,
  CHECKOUTS_DIRECTORY,
  RELEASE_DIRECTORY,
  sshAccessOf,
  type WorkspaceRoot,
} from "./workspace.ts";

const NO_REFS: readonly string[] = [];
const NO_TREES = 0;
const MIN_DEADLINE_MS = 1;
const PARENT = "..";
const BUDGET_END = "budget end";

type PortFailure = Extract<
  PortResult<never>,
  { kind: typeof PortResultKind.Failed }
>;
type StopMapper = Pick<ExecutionRun, "stopOf">;

export interface BaseTreeHost {
  workspaces: WorkspaceRoot;
  nodeId: string;
  env: NodeJS.ProcessEnv;
  addressOf: (checkout: CheckoutRef) => string;
  run: StopMapper;
}

async function failedOf(run: StopMapper, error: unknown): Promise<PortFailure> {
  const stop = await run.stopOf(error);
  return {
    kind: PortResultKind.Failed,
    code: stop.code,
    message: stop.detail ?? stop.message,
  };
}

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
        return failedOf(run, error);
      }
    },
  };
}

function repositoryPort(input: StepsInput, run: ExecutionRun): RepositoryPort {
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
        return failedOf(run, error);
      }
    },
  };
}

function layoutOf(checkouts: string, directory: string): string {
  const path = relative(checkouts, directory);
  assert.ok(!path.startsWith(PARENT) && !isAbsolute(path));
  return path;
}

export function baseTreeTaker(host: BaseTreeHost): ReleaseTreePort["takeBase"] {
  return async (checkout, commit, call) => {
    const { env } = host;
    const { context } = call;
    const directory = join(
      host.workspaces.nodeKey(host.nodeId),
      BASE_DIRECTORY,
      checkout.name,
    );
    const address = host.addressOf(checkout);
    const remaining = () =>
      Math.max(MIN_DEADLINE_MS, call.deadline - Date.now());
    const git = () => ({ env, directory, context, deadlineMs: remaining() });
    try {
      const { source } = await prepareTree({
        pool: host.workspaces.pool,
        address,
        poolClass: PoolClass.Command,
        target: directory,
        nodeId: host.nodeId,
        keepRefs: NO_REFS,
        env,
        context,
        deadlineMs: remaining(),
        fresh: async () => {
          await clonePacked(git(), checkout.directory);
          await fetchLocal(git(), checkout.directory);
          await checkoutDetached(env, directory, commit, context, remaining());
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
      return failedOf(host.run, error);
    }
  };
}

function releaseTreePort(
  input: StepsInput,
  run: ExecutionRun,
): ReleaseTreePort {
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
        return failedOf(run, error);
      }
    },
    takeBase: baseTreeTaker({
      workspaces,
      nodeId,
      env: input.env,
      addressOf,
      run,
    }),
    async give(tree) {
      giveBack(tree, tree.directory);
    },
  };
}

export type AgentOpener = (workspace: string) => Promise<NativeAgent>;

export interface AgentHost {
  run: ExecutionRun;
  budget: ExecutionBudget;
  open: AgentOpener;
}

export function agentPort(host: AgentHost): AgentPort {
  return {
    async open(request) {
      const workspace = request.reviewWorkspace;
      assert.ok(workspace);
      try {
        return ok(await host.open(workspace.directory));
      } catch (error) {
        if (endedByBudget(host, error))
          return {
            kind: PortResultKind.Failed,
            code: null,
            message: BUDGET_END,
          };
        return failedOf(host.run, error);
      }
    },
  };
}

function commonPorts(run: ExecutionRun): CommonPorts {
  return {
    telemetry: run.spans,
    secrets: { redact: (text) => run.redact(text) },
    log: { log: (message, fields) => run.log(message, fields) },
  };
}

export function evaluationPorts(
  run: ExecutionRun,
  agent: AgentPort,
): EvaluationPorts {
  return { ...commonPorts(run), evidence: evidencePort(run), agent };
}

export function examinePorts(
  run: ExecutionRun,
  agent: AgentPort,
): ExaminePorts {
  return { ...commonPorts(run), evidence: evidencePort(run), agent };
}

export function workerPorts(
  input: StepsInput,
  run: ExecutionRun,
): ImplementPorts {
  return {
    ...commonPorts(run),
    evidence: evidencePort(run),
    repository: repositoryPort(input, run),
    releaseTrees: releaseTreePort(input, run),
  };
}
