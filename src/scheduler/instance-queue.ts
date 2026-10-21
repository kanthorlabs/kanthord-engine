export class InstanceQueue {
  private readonly waiting = new Set<string>();
  private readonly wake: (runtimeIdentities: string[]) => void;

  constructor(wake: (runtimeIdentities: string[]) => void) {
    this.wake = wake;
  }

  wait(runtimeIdentity: string): void {
    this.waiting.add(runtimeIdentity);
  }

  turn(runtimeIdentity: string, siblings: string[]): boolean {
    for (const waiting of this.waiting) {
      if (waiting === runtimeIdentity) return true;
      if (siblings.includes(waiting)) return false;
    }
    return true;
  }

  waits(runtimeIdentity: string): boolean {
    return this.waiting.has(runtimeIdentity);
  }

  claimed(runtimeIdentity: string, siblings: string[]): void {
    this.waiting.delete(runtimeIdentity);
    for (const sibling of siblings) this.wait(sibling);
  }

  prune(live: (runtimeIdentity: string) => boolean): void {
    for (const waiting of [...this.waiting])
      if (!live(waiting)) this.waiting.delete(waiting);
  }

  pass(runtimeIdentity: string, siblings: string[]): void {
    if (!this.waiting.delete(runtimeIdentity)) return;
    const waiting = siblings.filter((sibling) => this.waiting.has(sibling));
    if (waiting.length) this.wake(waiting);
  }
}
