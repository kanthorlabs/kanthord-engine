import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ensureDirectory } from "../../kernel/files.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { bindingNameSchema } from "../../project/contract.ts";
import type { Context } from "../../kernel/context.ts";
import type { RepositoryTransport, SshIdentityPin } from "../contract.ts";

export const WORKSPACES_DIRECTORY = "workspaces";
export const SCRATCH_DIRECTORY = ".kanthord-scratch/";
const GIT_EXCLUDE = [".git", "info", "exclude"];
export const WORKSPACE_RETENTION_MS = 7 * 24 * 3600 * 1000;
export const SWEEP_INTERVAL_MS = 3600000;
export const CHECKOUTS_DIRECTORY = "checkouts";
export const EVIDENCE_DIRECTORY = "evidence";
const SINGLE_CHECKOUT = 1;
const FIRST_CHECKOUT = 0;
export const WorkspaceKind = {
  Node: "node",
  Execution: "execution",
} as const;
export type WorkspaceKind = (typeof WorkspaceKind)[keyof typeof WorkspaceKind];
interface Preparation {
  transport: RepositoryTransport;
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
interface WorkspaceRepository {
  binding_id: string;
  name: string;
  address: string;
  ssh_identity: SshIdentityPin;
  strategy: { base_branch: string };
}

export class WorkspaceRoot {
  readonly root: string;
  private readonly held = new Set<string>();
  private timer?: NodeJS.Timeout;
  private constructor(root: string) {
    this.root = root;
  }
  static open(stateDirectory: string): WorkspaceRoot {
    assert.ok(stateDirectory);
    const root = resolve(stateDirectory, WORKSPACES_DIRECTORY);
    ensureDirectory(root);
    assert.equal(dirname(root), resolve(stateDirectory));
    return new WorkspaceRoot(root);
  }
  nodeKey(nodeId: string): string {
    return join(this.root, identitySchema("node").parse(nodeId));
  }
  nodeDirectory(nodeId: string, bindingId: string): string {
    return join(
      this.nodeKey(nodeId),
      identitySchema("binding").parse(bindingId),
    );
  }
  executionKey(executionId: string): string {
    return join(this.root, identitySchema("execution").parse(executionId));
  }
  async prepareImplement(
    input: Preparation & {
      nodeId: string;
      nodeBranch: string;
      pushed: boolean;
      repository: WorkspaceRepository;
    },
  ): Promise<{ directory: string; head: string; nodeBranch: string }> {
    const key = this.nodeKey(input.nodeId);
    const directory = this.nodeDirectory(
      input.nodeId,
      input.repository.binding_id,
    );
    const existing = existsSync(directory);
    this.hold(key);
    const end = performance.now() + input.deadlineMs;
    try {
      ensureDirectory(key);
      ensureDirectory(directory);
      this.touch(key);
      if (!existing) {
        await input.transport.proveSshIdentity(
          input.repository.ssh_identity,
          input.context,
          end - performance.now(),
        );
        await input.transport.clone(
          input.repository.address,
          directory,
          input.context,
          end - performance.now(),
        );
      }
      await input.transport.proveSshIdentity(
        input.repository.ssh_identity,
        input.context,
        end - performance.now(),
      );
      const head = await input.transport.fetchAndCheckout(
        directory,
        input.nodeBranch,
        input.repository.strategy.base_branch,
        input.pushed,
        input.context,
        end - performance.now(),
      );
      excludeScratch(directory);
      return { directory, head, nodeBranch: input.nodeBranch };
    } catch (error) {
      this.held.delete(key);
      if (!existing) rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async prepareSnapshot(
    input: Preparation & {
      executionId: string;
      repository: {
        name: string;
        address: string;
        ssh_identity: SshIdentityPin;
      };
      commit: string;
    },
  ): Promise<{ key: string; directory: string; head: string }> {
    const { directory: key } = this.prepareExecution(input);
    const end = performance.now() + input.deadlineMs;
    try {
      const name = bindingNameSchema.parse(input.repository.name);
      const directory = join(key, CHECKOUTS_DIRECTORY, name);
      ensureDirectory(directory);
      await input.transport.proveSshIdentity(
        input.repository.ssh_identity,
        input.context,
        end - performance.now(),
      );
      const head = await input.transport.cloneSnapshot(
        input.repository.address,
        input.commit,
        directory,
        input.context,
        end - performance.now(),
      );
      return { key, directory, head };
    } catch (error) {
      this.release(key, WorkspaceKind.Execution);
      throw error;
    }
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
    const { directory: key } = this.prepareExecution(input);
    const end = performance.now() + input.deadlineMs;
    const checkouts: ExamineCheckout[] = [];
    const testedInput: RepositoryAddress[] = [];
    try {
      for (const repository of input.repositories) {
        const name = bindingNameSchema.parse(repository.name);
        const target = join(key, CHECKOUTS_DIRECTORY, name);
        assert.ok(!existsSync(target), "Duplicate repository binding");
        ensureDirectory(target);
        await input.transport.proveSshIdentity(
          repository.ssh_identity,
          input.context,
          end - performance.now(),
        );
        const commit = await input.transport.cloneSnapshot(
          repository.address,
          `origin/${repository.strategy.base_branch}`,
          target,
          input.context,
          end - performance.now(),
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
  release(key: string, kind: WorkspaceKind): void {
    assert.equal(dirname(key), this.root);
    assert.ok(this.held.has(key));
    if (kind === WorkspaceKind.Node) this.touch(key);
    else rmSync(key, { recursive: true, force: true });
    this.held.delete(key);
  }
  sweep(now: number): void {
    assert.ok(Number.isFinite(now));
    assert.ok(this.root);
    for (const entry of readdirSync(this.root)) {
      const key = join(this.root, entry);
      if (this.held.has(key)) continue;
      if (lstatSync(key).mtimeMs < now - WORKSPACE_RETENTION_MS)
        rmSync(key, { recursive: true, force: true });
    }
  }
  startSweeping(): void {
    assert.equal(this.timer, undefined);
    assert.ok(this.root);
    this.sweep(Date.now());
    this.timer = setInterval(() => this.sweep(Date.now()), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }
  stopSweeping(): void {
    clearInterval(this.timer);
    this.timer = undefined;
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
