import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureDirectory } from "../kernel/files.ts";
import { identitySchema } from "../kernel/identity.ts";
import { bindingNameSchema } from "../project/contract.ts";
import type { Context } from "../kernel/context.ts";
import type { RepositoryTransport, SshIdentityPin } from "./contract.ts";
import { nodeBranchOf } from "./node-branch.ts";
export { nodeBranchOf } from "./node-branch.ts";

export const WORKSPACES_DIRECTORY = "workspaces";
export const WORKSPACE_RETENTION_MS = 7 * 24 * 3600 * 1000;
export const SWEEP_INTERVAL_MS = 3600000;
export const WorkspaceKind = {
  Objective: "objective",
  Execution: "execution",
} as const;
export type WorkspaceKind = (typeof WorkspaceKind)[keyof typeof WorkspaceKind];
interface Preparation {
  transport: RepositoryTransport;
  context: Context;
  deadlineMs: number;
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
  objectiveKey(objectiveId: string): string {
    return join(this.root, identitySchema("node").parse(objectiveId));
  }
  objectiveDirectory(objectiveId: string, bindingId: string): string {
    return join(
      this.objectiveKey(objectiveId),
      identitySchema("binding").parse(bindingId),
    );
  }
  executionKey(executionId: string): string {
    return join(this.root, identitySchema("execution").parse(executionId));
  }
  async prepareObjective(
    input: Preparation & {
      objectiveId: string;
      repository: WorkspaceRepository;
    },
  ): Promise<{ directory: string; head: string; nodeBranch: string }> {
    const key = this.objectiveKey(input.objectiveId);
    const directory = this.objectiveDirectory(
      input.objectiveId,
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
      const nodeBranch = nodeBranchOf(input.objectiveId);
      await input.transport.proveSshIdentity(
        input.repository.ssh_identity,
        input.context,
        end - performance.now(),
      );
      const head = await input.transport.fetchAndCheckout(
        directory,
        nodeBranch,
        input.repository.strategy.base_branch,
        input.context,
        end - performance.now(),
      );
      return { directory, head, nodeBranch };
    } catch (error) {
      this.held.delete(key);
      if (!existing) rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async prepareSnapshot(
    input: Preparation & {
      executionId: string;
      repository: { address: string; ssh_identity: SshIdentityPin };
      commit: string;
    },
  ): Promise<{ directory: string; head: string }> {
    const { directory } = this.prepareExecution(input);
    const end = performance.now() + input.deadlineMs;
    try {
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
      return { directory, head };
    } catch (error) {
      this.release(directory, WorkspaceKind.Execution);
      throw error;
    }
  }
  async prepareInitiative(
    input: Preparation & {
      executionId: string;
      repositories: WorkspaceRepository[];
    },
  ): Promise<{
    directory: string;
    tested_input:
      { kind: "repository"; binding_id: string; commit: string }[] | null;
  }> {
    const { directory } = this.prepareExecution(input);
    const end = performance.now() + input.deadlineMs;
    const testedInput: {
      kind: "repository";
      binding_id: string;
      commit: string;
    }[] = [];
    try {
      for (const repository of input.repositories) {
        const target = join(
          directory,
          bindingNameSchema.parse(repository.name),
        );
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
        testedInput.push({
          kind: "repository",
          binding_id: repository.binding_id,
          commit,
        });
      }
      return {
        directory,
        tested_input: testedInput.length ? testedInput : null,
      };
    } catch (error) {
      this.release(directory, WorkspaceKind.Execution);
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
    if (kind === WorkspaceKind.Objective) this.touch(key);
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
