import { constants, createWriteStream, type WriteStream } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { Logger } from "pino";
import { deriveClientSecret, generateSlotJWT } from "../../gateway/auth/jwt.ts";
import { type createInvocation, servePort } from "../../gateway/index.ts";
import { ensureDirectory, openPrivate } from "../../kernel/files.ts";
import {
  BindingEntryState,
  type PlacementStatus,
  type PoolEntry,
  type PoolHost,
  type PoolInstance,
  type PoolPlacement,
} from "../../worker/contract.ts";
import { SlotControl } from "../worker/thread-data.ts";
import type { SlotDriver, SlotEntry, SlotInstance } from "./slot-driver.ts";

export const POOL_BACKOFF_INITIAL_MS = 1000;
export const POOL_BACKOFF_MAX_MS = 30000;
export const POOL_STOP_DEADLINE_MS = 5000;
const BACKOFF_FACTOR = 2;
const WORKERS_DIRECTORY = "workers";
const STDERR_LOG = "stderr.log";
const BINDING_NAME_INDEX = 2;
const IDENTITY_SEPARATOR = ":";
const MISSING_ENTRY = "ENOENT";
export interface WorkerPoolOptions {
  invocation: ReturnType<typeof createInvocation>;
  masterKey: string;
  authVersion: number;
  instanceLimit: number;
  stateDirectory: string;
  logger: Logger;
  drivers: ReadonlyMap<PoolPlacement, SlotDriver>;
  environment?: NodeJS.ProcessEnv;
}

interface Hosted {
  instance: PoolInstance;
  entries: readonly PoolEntry[];
  pending: boolean;
  running?: SlotInstance;
  ports: Map<string, MessagePort>;
  log?: WriteStream;
  requested: SlotControl["kind"] | null;
  resume: boolean;
  failure: Error | null;
  delay: number;
  startedAt: number;
  timer?: NodeJS.Timeout;
  exit: PromiseWithResolvers<void>;
}

function olderThan(left: PoolInstance, right: PoolInstance): boolean {
  return (
    left.created_at < right.created_at ||
    (left.created_at === right.created_at && left.name < right.name)
  );
}

export class WorkerPool implements PoolHost {
  private readonly options: WorkerPoolOptions;
  private readonly hosted = new Map<string, Hosted>();
  private stopping = false;

  constructor(options: WorkerPoolOptions) {
    this.options = options;
  }

  placementStatus(placement: PoolPlacement): Promise<PlacementStatus> {
    return this.driver(placement).check();
  }

  prepare(): void {
    for (const driver of this.options.drivers.values())
      driver.prepare().catch(() => {});
  }

  async sweep(live: ReadonlySet<string>): Promise<void> {
    await Promise.all([
      this.guarded(null, () => this.sweepRoots(live)),
      ...Array.from(this.options.drivers.values(), (driver) =>
        this.guarded(null, () => driver.sweepVolumes(live)),
      ),
    ]);
  }

  start(instance: PoolInstance, entries: readonly PoolEntry[]): void {
    if (this.stopping) return;
    const existing = this.hosted.get(instance.id);
    if (existing) {
      this.update(instance, entries);
      return;
    }
    const pending = this.started() >= this.options.instanceLimit;
    if (pending)
      this.options.logger.warn(
        { instance: instance.name },
        "worker.pool.instance_limit",
      );
    const hosted: Hosted = {
      instance,
      entries,
      pending,
      ports: new Map(),
      requested: null,
      resume: false,
      failure: null,
      delay: POOL_BACKOFF_INITIAL_MS,
      startedAt: 0,
      exit: Promise.withResolvers<void>(),
    };
    this.hosted.set(instance.id, hosted);
    if (!pending) this.launch(hosted);
  }

  update(instance: PoolInstance, entries: readonly PoolEntry[]): void {
    const hosted = this.hosted.get(instance.id);
    if (!hosted) return;
    hosted.entries = entries;
    hosted.running?.bindings(this.slotEntries(hosted));
  }

  restart(instance: PoolInstance): void {
    const hosted = this.hosted.get(instance.id);
    if (!hosted?.running) return;
    hosted.resume = true;
    if (hosted.requested === SlotControl.Drain) return;
    hosted.requested = SlotControl.Drain;
    hosted.running.control(SlotControl.Drain);
  }

  imageOf(instance: PoolInstance): string | null {
    return this.driver(instance.placement).imageOf?.(instance.name) ?? null;
  }

  async archive(instance: PoolInstance): Promise<void> {
    const hosted = this.hosted.get(instance.id);
    if (hosted) await this.halt(hosted);
    await Promise.all([
      this.guarded(instance.name, () => this.removeRoot(instance.name)),
      this.guarded(instance.name, () =>
        this.driver(instance.placement).removeVolume(instance.name),
      ),
    ]);
    this.promote();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(
      Array.from(this.hosted.values(), (hosted) => this.halt(hosted)),
    );
  }

  private started(): number {
    let count = 0;
    for (const hosted of this.hosted.values()) if (!hosted.pending) count++;
    return count;
  }

  private promote(): void {
    if (this.stopping || this.started() >= this.options.instanceLimit) return;
    let next: Hosted | undefined;
    for (const candidate of this.hosted.values())
      if (
        candidate.pending &&
        (!next || olderThan(candidate.instance, next.instance))
      )
        next = candidate;
    if (!next) return;
    next.pending = false;
    this.launch(next);
  }

  private async halt(hosted: Hosted): Promise<void> {
    clearTimeout(hosted.timer);
    const running = hosted.running;
    if (!running) {
      this.hosted.delete(hosted.instance.id);
      return;
    }
    hosted.requested = SlotControl.Stop;
    running.control(SlotControl.Stop);
    const deadline = setTimeout(() => {
      running.terminate();
    }, POOL_STOP_DEADLINE_MS);
    try {
      await hosted.exit.promise;
    } finally {
      clearTimeout(deadline);
    }
  }

  private workersDirectory(): string {
    return join(this.options.stateDirectory, WORKERS_DIRECTORY);
  }

  private removeRoot(instanceName: string): Promise<void> {
    return rm(join(this.workersDirectory(), instanceName), {
      recursive: true,
      force: true,
    });
  }

  private async sweepRoots(live: ReadonlySet<string>): Promise<void> {
    const names = await readdir(this.workersDirectory()).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === MISSING_ENTRY) return [];
        throw error;
      },
    );
    for (const name of names) if (!live.has(name)) await this.removeRoot(name);
  }

  private async guarded(
    instanceName: string | null,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.options.logger.error(
        {
          err: error instanceof Error ? error : new Error(String(error)),
          instance: instanceName ?? undefined,
        },
        "worker.pool.cleanup_failed",
      );
    }
  }

  private token(instance: PoolInstance, entry: PoolEntry): Promise<string> {
    return generateSlotJWT(this.options.masterKey, this.options.authVersion, {
      clientId: entry.client_id,
      projectId: entry.project_id,
      bindingName:
        entry.resource_identity.split(IDENTITY_SEPARATOR)[BINDING_NAME_INDEX]!,
      instanceId: instance.id,
      instanceName: instance.name,
    }).then(({ token }) => token);
  }

  private open(hosted: Hosted, entry: PoolEntry): MessagePort {
    const { port1, port2 } = new MessageChannel();
    hosted.ports.set(entry.client_id, port1);
    port1.once("close", () => {
      if (hosted.ports.get(entry.client_id) === port1)
        hosted.ports.delete(entry.client_id);
    });
    servePort(
      port1,
      this.options.invocation,
      () => this.token(hosted.instance, entry),
      this.options.logger,
    );
    return port2;
  }

  private slotEntries(hosted: Hosted): SlotEntry[] {
    return hosted.entries.map((entry) => {
      const known = hosted.ports.has(entry.client_id);
      const opens = !known && entry.state === BindingEntryState.Serving;
      return {
        ...entry,
        client_secret: deriveClientSecret(
          this.options.masterKey,
          this.options.authVersion,
          entry.client_id,
        ),
        channel: opens ? this.open(hosted, entry) : null,
      };
    });
  }

  private driver(placement: PoolPlacement): SlotDriver {
    const driver = this.options.drivers.get(placement);
    if (!driver)
      throw new Error("worker pool: no slot driver for the placement");
    return driver;
  }

  private launch(hosted: Hosted): void {
    if (this.stopping) return;
    const { instance } = hosted;
    try {
      const root = join(this.workersDirectory(), instance.name);
      ensureDirectory(root);
      const logPath = join(root, STDERR_LOG);
      const log = createWriteStream(logPath, {
        fd: openPrivate(
          logPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
        ),
      });
      hosted.log = log;
      const entries = hosted.entries.map((entry) => ({
        ...entry,
        client_secret: deriveClientSecret(
          this.options.masterKey,
          this.options.authVersion,
          entry.client_id,
        ),
        channel: this.open(hosted, entry),
      }));
      const running = this.driver(instance.placement).launch({
        instance,
        entries,
        root,
        output: log,
        environment: this.options.environment ?? process.env,
      });
      hosted.running = running;
      hosted.failure = null;
      hosted.requested = null;
      hosted.startedAt = Date.now();
      hosted.exit = Promise.withResolvers<void>();
      void running.exited.then(({ code, error }) => {
        if (error) hosted.failure = error;
        this.exited(hosted, code);
      });
    } catch (error) {
      hosted.failure =
        error instanceof Error ? error : new Error(String(error));
      this.exited(hosted, 1);
    }
  }

  private exited(hosted: Hosted, code: number): void {
    for (const port of hosted.ports.values()) port.close();
    hosted.ports.clear();
    hosted.log?.end();
    hosted.log = undefined;
    hosted.running = undefined;
    const requested = hosted.requested;
    hosted.requested = null;
    hosted.exit.resolve();
    if (this.stopping || requested === SlotControl.Stop) {
      this.hosted.delete(hosted.instance.id);
      return;
    }
    if (hosted.resume) {
      hosted.resume = false;
      this.launch(hosted);
      return;
    }
    this.fail(hosted, code);
  }

  private fail(hosted: Hosted, code: number): void {
    this.options.logger.error(
      {
        err: hosted.failure ?? undefined,
        exit_code: code,
        instance: hosted.instance.name,
      },
      "worker.pool.instance_failed",
    );
    if (Date.now() - hosted.startedAt >= POOL_BACKOFF_MAX_MS)
      hosted.delay = POOL_BACKOFF_INITIAL_MS;
    const delay = hosted.delay;
    hosted.delay = Math.min(delay * BACKOFF_FACTOR, POOL_BACKOFF_MAX_MS);
    hosted.timer = setTimeout(() => this.launch(hosted), delay);
    hosted.timer.unref();
  }
}
