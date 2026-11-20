import { CancellationContext } from "../../kernel/context.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";
import { type ExecutionRun, isRevokeAnswer } from "./execution-run.ts";

export const CLAIM_WATCH_INTERVAL_MS = 60000;

export class ClaimWatch implements Disposable {
  private readonly run: ExecutionRun;
  private readonly reads: CancellationContext;
  private readonly timer: NodeJS.Timeout;
  private readonly links: readonly Disposable[];
  private reading = false;

  constructor(run: ExecutionRun) {
    this.run = run;
    this.reads = new CancellationContext(run.operationContext);
    this.timer = setInterval(() => void this.fire(), CLAIM_WATCH_INTERVAL_MS);
    this.links = [
      run.onStop(() => this.end()),
      run.onFinalStep(() => this.end()),
    ];
  }

  end(): void {
    clearInterval(this.timer);
    this.reads.cancel();
    for (const link of this.links) link[Symbol.dispose]();
  }

  [Symbol.dispose](): void {
    this.end();
  }

  private async fire(): Promise<void> {
    if (this.reading || this.reads.signal.aborted) return;
    this.reading = true;
    try {
      if (await this.revoked()) this.run.revoke();
    } finally {
      this.reading = false;
    }
  }

  private async revoked(): Promise<boolean> {
    const { run, reads } = this;
    try {
      const result = await run.clients.scheduler.claimGet(
        {
          params: { execution_id: run.claim.execution_id },
          query: {},
          body: null,
        },
        { context: reads, idempotencyKey: createIdempotencyKey() },
      );
      return !reads.signal.aborted && isRevokeAnswer(result);
    } catch {
      return false;
    }
  }
}
