import assert from "node:assert/strict";
import type { Context } from "../kernel/context.ts";
import { WORK_PULL_WAIT_MS } from "./contract.ts";

const NO_WAITERS = 0;
interface Waiter {
  runtimeIdentity: string;
  finish(): void;
}

export class WaitingPulls {
  private readonly projects = new Map<string, Set<Waiter>>();
  private readonly scheduled = new Map<string, NodeJS.Immediate>();

  park(
    projectId: string,
    runtimeIdentity: string,
    remainingMs: number,
    context: Context,
  ): Promise<void> {
    assert.ok(
      projectId.length > NO_WAITERS && runtimeIdentity.length > NO_WAITERS,
    );
    assert.ok(Number.isFinite(remainingMs) && remainingMs <= WORK_PULL_WAIT_MS);
    if (context.err() || remainingMs <= NO_WAITERS) return Promise.resolve();
    const completion = Promise.withResolvers<void>();
    const waiters = this.projects.get(projectId) ?? new Set<Waiter>();
    this.projects.set(projectId, waiters);
    let finished = false;
    let unsubscribe = () => {};
    const waiter: Waiter = {
      runtimeIdentity,
      finish: () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        unsubscribe();
        waiters.delete(waiter);
        if (waiters.size === NO_WAITERS) {
          this.projects.delete(projectId);
          clearImmediate(this.scheduled.get(projectId));
          this.scheduled.delete(projectId);
        }
        completion.resolve();
      },
    };
    waiters.add(waiter);
    const timer = setTimeout(waiter.finish, remainingMs);
    unsubscribe = context.onCancel(waiter.finish);
    if (finished) unsubscribe();
    return completion.promise;
  }

  wake(projectId: string): void {
    if (!this.projects.has(projectId) || this.scheduled.has(projectId)) return;
    this.scheduled.set(
      projectId,
      setImmediate(() => {
        this.scheduled.delete(projectId);
        const waiters = [...(this.projects.get(projectId) ?? [])];
        for (let index = 0; index < waiters.length; index++)
          waiters[index]!.finish();
      }),
    );
  }

  wakeAll(): void {
    const waiters = [...this.projects.values()].flatMap((project) => [
      ...project,
    ]);
    for (let index = 0; index < waiters.length; index++)
      waiters[index]!.finish();
    assert.equal(this.projects.size, NO_WAITERS);
    assert.equal(this.scheduled.size, NO_WAITERS);
  }

  pulling(runtimeIdentity: string): boolean {
    return [...this.projects.values()].some((waiters) =>
      [...waiters].some((waiter) => waiter.runtimeIdentity === runtimeIdentity),
    );
  }
  size(): number {
    return [...this.projects.values()].reduce(
      (count, waiters) => count + waiters.size,
      NO_WAITERS,
    );
  }
  projectIds(): string[] {
    return [...this.projects.keys()];
  }
}
