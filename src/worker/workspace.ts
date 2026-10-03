import assert from "node:assert/strict";
import { lstatSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureDirectory } from "../kernel/files.ts";
import { identitySchema } from "../kernel/identity.ts";
export { nodeBranchOf } from "./node-branch.ts";

export const WORKSPACES_DIRECTORY = "workspaces";
export const WORKSPACE_RETENTION_MS = 7 * 24 * 3600 * 1000;
export const SWEEP_INTERVAL_MS = 3600000;
export const WorkspaceKind = {
  Objective: "objective",
  Execution: "execution",
} as const;
export type WorkspaceKind = (typeof WorkspaceKind)[keyof typeof WorkspaceKind];

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
