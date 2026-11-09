import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { WORKSPACE_KEY_PATTERN } from "../../kernel/cleanup.ts";
import { ensureDirectory, FILE_NOT_FOUND } from "../../kernel/files.ts";
import { walkFootprint } from "../../kernel/footprint-walk.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { bindingNameSchema } from "../../project/contract.ts";
import type { Context } from "../../kernel/context.ts";
import type { ExecutionSetup, RepositoryTransport } from "../contract.ts";
import type { SshAccess, SshSigner } from "../../repository/contract.ts";
import { RepositoryComponent } from "../../repository/index.ts";
import { cleanExcludes, originAddress } from "./local-git.ts";
import { readSetupRecord } from "./setup-record.ts";
import { isTree, POOL_DIRECTORY, PoolClass, TreePool } from "./tree-pool.ts";
import type { HandoverSshIdentity } from "../../custody/contract.ts";

export const WORKSPACES_DIRECTORY = "workspaces";
export const SCRATCH_DIRECTORY = ".kanthord-scratch/";
const GIT_EXCLUDE = [".git", "info", "exclude"];
export const CHECKOUTS_DIRECTORY = "checkouts";
export const RELEASE_DIRECTORY = "release";
export const EVIDENCE_DIRECTORY = "evidence";
const NO_CHECKOUTS = 0;
const SINGLE_CHECKOUT = 1;
const FIRST_CHECKOUT = 0;
export const WorkspaceKind = {
  Node: "node",
  Execution: "execution",
} as const;
export type WorkspaceKind = (typeof WorkspaceKind)[keyof typeof WorkspaceKind];
export const WorkspaceRemoval = {
  Removed: "removed",
  Absent: "absent",
  Live: "live",
  Unreadable: "unreadable",
} as const;
export type WorkspaceRemoval =
  (typeof WorkspaceRemoval)[keyof typeof WorkspaceRemoval];
const NO_BYTES = 0;
interface Preparation {
  transport: RepositoryTransport;
  sshAccess: ReadonlyMap<string, SshAccess>;
  context: Context;
  deadlineMs: number;
}
interface RepositoryAddress {
  kind: "repository";
  binding_id: string;
  commit: string;
}
export interface ExamineCheckout {
  name: string;
  directory: string;
  base_branch: string;
}
export interface WorkspaceCheckout {
  binding_id: string;
  name: string;
  directory: string;
  head: string;
}
interface WorkspaceRepository {
  binding_id: string;
  name: string;
  address: string;
  strategy: { base_branch: string; upstream_branch?: string };
}

export function handedSshAccess(
  identities: readonly HandoverSshIdentity[],
  repositories: ExecutionSetup["repositories"],
  relay?: (bindingId: string) => SshSigner,
): Map<string, SshAccess> {
  const access = new Map<string, SshAccess>();
  for (const repository of repositories) {
    const identity = identities.find(
      (entry) => entry.binding_id === repository.binding_id,
    );
    const known_hosts = repository.ssh_host_key.known_hosts;
    const port = RepositoryComponent.sshPortOfAddress(repository.address);
    if (identity) {
      access.set(
        repository.binding_id,
        RepositoryComponent.handedSshAccess(
          identity.private_key,
          known_hosts,
          port,
        ),
      );
      continue;
    }
    assert.ok(
      relay,
      "A repository binding must hold a handed SSH identity or a relay",
    );
    access.set(repository.binding_id, {
      relay: relay(repository.binding_id),
      public_key: repository.ssh_public_key,
      known_hosts,
      port,
    });
  }
  return access;
}

export function sshAccessOf(
  sshAccess: ReadonlyMap<string, SshAccess>,
  bindingId: string,
): SshAccess {
  const access = sshAccess.get(bindingId);
  assert.ok(access, "A repository binding must hold an SSH identity");
  return access;
}

export class WorkspaceRoot {
  readonly root: string;
  readonly pool: TreePool;
  private readonly held = new Set<string>();
  private constructor(root: string, pool: TreePool) {
    this.root = root;
    this.pool = pool;
  }
  static open(stateDirectory: string): WorkspaceRoot {
    assert.ok(stateDirectory);
    const root = resolve(stateDirectory, WORKSPACES_DIRECTORY);
    ensureDirectory(root);
    assert.equal(dirname(root), resolve(stateDirectory));
    return new WorkspaceRoot(root, TreePool.open(join(root, POOL_DIRECTORY)));
  }
  nodeKey(nodeId: string): string {
    return join(this.root, identitySchema("node").parse(nodeId));
  }
  nodeDirectory(nodeId: string, bindingName: string): string {
    return join(
      this.nodeKey(nodeId),
      CHECKOUTS_DIRECTORY,
      bindingNameSchema.parse(bindingName),
    );
  }
  executionKey(executionId: string): string {
    return join(this.root, identitySchema("execution").parse(executionId));
  }
  async prepareImplement(
    input: Preparation & {
      env: NodeJS.ProcessEnv;
      nodeId: string;
      nodeBranch: string;
      pushed: ReadonlySet<string>;
      repositories: readonly WorkspaceRepository[];
    },
  ): Promise<{ root: string; checkouts: WorkspaceCheckout[] }> {
    assert.ok(input.repositories.length > NO_CHECKOUTS);
    const key = this.nodeKey(input.nodeId);
    this.hold(key);
    const end = performance.now() + input.deadlineMs;
    const created: string[] = [];
    try {
      ensureDirectory(key);
      this.touch(key);
      if (existsSync(join(key, RELEASE_DIRECTORY)))
        await this.giveReleaseTrees(key, input, end);
      const checkouts: WorkspaceCheckout[] = [];
      for (const repository of input.repositories) {
        const directory = this.nodeDirectory(input.nodeId, repository.name);
        assert.ok(
          !checkouts.some((checkout) => checkout.directory === directory),
          "Duplicate repository binding",
        );
        const ssh = sshAccessOf(input.sshAccess, repository.binding_id);
        if (!existsSync(directory)) {
          created.push(directory);
          ensureDirectory(directory);
          await input.transport.clone(
            repository.address,
            directory,
            input.context,
            end - performance.now(),
            ssh,
          );
        }
        const record = await readSetupRecord({
          env: input.env,
          directory,
          context: input.context,
          deadlineMs: end - performance.now(),
        });
        const head = await input.transport.fetchAndCheckout(
          directory,
          input.nodeBranch,
          repository.strategy.base_branch,
          input.pushed.has(repository.binding_id),
          cleanExcludes(record?.roots ?? []),
          input.context,
          end - performance.now(),
          ssh,
        );
        excludeScratch(directory);
        checkouts.push({
          binding_id: repository.binding_id,
          name: repository.name,
          directory,
          head,
        });
      }
      return {
        root:
          checkouts.length > SINGLE_CHECKOUT
            ? join(key, CHECKOUTS_DIRECTORY)
            : checkouts[FIRST_CHECKOUT]!.directory,
        checkouts,
      };
    } catch (error) {
      this.held.delete(key);
      for (const directory of created)
        rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  private async giveReleaseTrees(
    key: string,
    input: Preparation & {
      env: NodeJS.ProcessEnv;
      nodeId: string;
      repositories: readonly WorkspaceRepository[];
    },
    end: number,
  ): Promise<void> {
    const release = join(key, RELEASE_DIRECTORY);
    for (const repository of input.repositories) {
      const tree = join(release, bindingNameSchema.parse(repository.name));
      if (!isTree(tree)) continue;
      const address = await originAddress({
        env: input.env,
        directory: tree,
        context: input.context,
        deadlineMs: end - performance.now(),
      }).catch((error: unknown) => {
        if (input.context.signal.aborted) throw error;
        return null;
      });
      if (address === repository.address)
        this.pool.giveBack(
          { address: repository.address, poolClass: PoolClass.Command },
          tree,
          input.nodeId,
        );
    }
    rmSync(release, { recursive: true, force: true });
  }
  async prepareSnapshots(
    input: Preparation & {
      executionId: string;
      snapshots: readonly {
        repository: WorkspaceRepository;
        commit: string;
      }[];
    },
  ): Promise<{
    key: string;
    directory: string;
    checkouts: ExamineCheckout[];
    tested_input: RepositoryAddress | RepositoryAddress[];
  }> {
    assert.ok(input.snapshots.length > NO_CHECKOUTS);
    const prepared = await this.prepareCheckouts(
      input,
      input.snapshots.map(({ repository, commit }) => ({
        repository,
        ref: commit,
      })),
    );
    return { ...prepared, tested_input: prepared.tested_input! };
  }
  async prepareExamine(
    input: Preparation & {
      executionId: string;
      repositories: WorkspaceRepository[];
    },
  ): Promise<{
    key: string;
    directory: string;
    checkouts: ExamineCheckout[];
    tested_input: RepositoryAddress | RepositoryAddress[] | null;
  }> {
    return this.prepareCheckouts(
      input,
      input.repositories.map((repository) => ({
        repository,
        ref: `origin/${repository.strategy.base_branch}`,
      })),
    );
  }
  private async prepareCheckouts(
    input: Preparation & { executionId: string },
    entries: readonly { repository: WorkspaceRepository; ref: string }[],
  ): Promise<{
    key: string;
    directory: string;
    checkouts: ExamineCheckout[];
    tested_input: RepositoryAddress | RepositoryAddress[] | null;
  }> {
    const { directory: key } = this.prepareExecution(input);
    const end = performance.now() + input.deadlineMs;
    const checkouts: ExamineCheckout[] = [];
    const testedInput: RepositoryAddress[] = [];
    try {
      for (const { repository, ref } of entries) {
        const name = bindingNameSchema.parse(repository.name);
        const target = join(key, CHECKOUTS_DIRECTORY, name);
        assert.ok(!existsSync(target), "Duplicate repository binding");
        ensureDirectory(target);
        const commit = await input.transport.cloneSnapshot(
          repository.address,
          ref,
          target,
          input.context,
          end - performance.now(),
          sshAccessOf(input.sshAccess, repository.binding_id),
        );
        checkouts.push({
          name,
          directory: target,
          base_branch: repository.strategy.base_branch,
        });
        testedInput.push({
          kind: "repository",
          binding_id: repository.binding_id,
          commit,
        });
      }
      const listed = checkouts.length > SINGLE_CHECKOUT;
      return {
        key,
        directory: listed
          ? join(key, CHECKOUTS_DIRECTORY)
          : (checkouts[FIRST_CHECKOUT]?.directory ?? key),
        checkouts,
        tested_input: listed
          ? testedInput
          : (testedInput[FIRST_CHECKOUT] ?? null),
      };
    } catch (error) {
      this.release(key, WorkspaceKind.Execution);
      throw error;
    }
  }
  prepareExecution(input: { executionId: string }): { directory: string } {
    const directory = this.executionKey(input.executionId);
    assert.ok(!existsSync(directory), "Execution workspace must be fresh");
    this.hold(directory);
    try {
      ensureDirectory(directory);
      return { directory };
    } catch (error) {
      this.held.delete(directory);
      throw error;
    }
  }
  hold(key: string): void {
    assert.equal(dirname(key), this.root);
    assert.ok(!this.held.has(key), "Workspace already held");
    this.held.add(key);
  }
  touch(key: string): void {
    assert.equal(dirname(key), this.root);
    assert.ok(this.held.has(key));
    const now = new Date();
    utimesSync(key, now, now);
  }
  async removeWorkspace(
    name: string,
    signal: AbortSignal,
  ): Promise<{ removal: WorkspaceRemoval; bytes: number }> {
    if (!WORKSPACE_KEY_PATTERN.test(name))
      return { removal: WorkspaceRemoval.Unreadable, bytes: NO_BYTES };
    const key = join(this.root, name);
    assert.equal(dirname(key), this.root);
    if (this.held.has(key))
      return { removal: WorkspaceRemoval.Live, bytes: NO_BYTES };
    const stats = await lstat(key).catch((error: NodeJS.ErrnoException) => {
      if (error.code === FILE_NOT_FOUND) return null;
      throw error;
    });
    if (!stats) return { removal: WorkspaceRemoval.Absent, bytes: NO_BYTES };
    if (!stats.isDirectory())
      return { removal: WorkspaceRemoval.Unreadable, bytes: NO_BYTES };
    const total = await walkFootprint(key, { signal });
    if (this.held.has(key))
      return { removal: WorkspaceRemoval.Live, bytes: NO_BYTES };
    rmSync(key, { recursive: true, force: true });
    return { removal: WorkspaceRemoval.Removed, bytes: total.bytes };
  }
  release(key: string, kind: WorkspaceKind): void {
    assert.equal(dirname(key), this.root);
    assert.ok(this.held.has(key));
    if (kind === WorkspaceKind.Node) this.touch(key);
    else rmSync(key, { recursive: true, force: true });
    this.held.delete(key);
  }
}

export function workRepositoriesOf(
  root: string,
  checkouts: readonly ExamineCheckout[],
): ExamineCheckout[] {
  return checkouts.map((checkout) => ({
    ...checkout,
    directory: relative(root, checkout.directory) || ".",
  }));
}

function excludeScratch(directory: string): void {
  const exclude = join(directory, ...GIT_EXCLUDE);
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (text.split("\n").includes(SCRATCH_DIRECTORY)) return;
  ensureDirectory(dirname(exclude));
  const separator = !text || text.endsWith("\n") ? "" : "\n";
  appendFileSync(exclude, `${separator}${SCRATCH_DIRECTORY}\n`);
}
