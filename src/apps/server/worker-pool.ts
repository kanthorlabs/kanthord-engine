import { constants, createWriteStream, type WriteStream } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { Logger } from "pino";
import { deriveClientSecret, generateSlotJWT } from "../../gateway/auth/jwt.ts";
import { type createInvocation, servePort } from "../../gateway/index.ts";
import { ensureDirectory, openPrivate } from "../../kernel/files.ts";
import type {
  PlacementStatus,
  PoolHost,
  PoolPlacement,
  PoolSlot,
} from "../../worker/contract.ts";
import { SlotControl } from "../worker/thread-data.ts";
import type { SlotDriver, SlotInstance } from "./slot-driver.ts";
import { slotClientIdentity } from "./slot-identity.ts";

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
  slotLimit: number;
  stateDirectory: string;
  logger: Logger;
  runtimeIdentity: (clientId: string) => string | undefined;
  drivers: ReadonlyMap<PoolPlacement, SlotDriver>;
  environment?: NodeJS.ProcessEnv;
}

interface Entry {
  slot: PoolSlot;
  pending: boolean;
  instance?: SlotInstance;
  port?: MessagePort;
  log?: WriteStream;
  requested: SlotControl["kind"] | null;
  resume: boolean;
  failure: Error | null;
  delay: number;
  startedAt: number;
  timer?: NodeJS.Timeout;
  exit: PromiseWithResolvers<void>;
}

export class WorkerPool implements PoolHost {
  private readonly options: WorkerPoolOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners: Array<(clientId: string) => void> = [];
  private stopping = false;

  constructor(options: WorkerPoolOptions) {
    this.options = options;
  }

  clientIdentity(
    projectId: string,
    resourceIdentity: string,
    generation: number,
    slot: number,
  ): string {
    return slotClientIdentity(
      this.options.masterKey,
      projectId,
      resourceIdentity,
      generation,
      slot,
    );
  }

  onEnded(listener: (clientId: string) => void): void {
    this.listeners.push(listener);
  }

  placementStatus(placement: PoolPlacement): Promise<PlacementStatus> {
    return this.driver(placement).check();
  }

  prepare(): void {
    for (const driver of this.options.drivers.values())
      driver.prepare().catch(() => {});
  }

  async remove(slot: PoolSlot): Promise<void> {
    const { client_id: clientId } = slot;
    await Promise.all([
      this.guarded(clientId, () => this.removeRoot(clientId)),
      this.guarded(clientId, () =>
        this.driver(slot.placement).removeVolume(clientId),
      ),
    ]);
  }

  async sweep(live: ReadonlySet<string>): Promise<void> {
    await Promise.all([
      this.guarded(null, () => this.sweepRoots(live)),
      ...Array.from(this.options.drivers.values(), (driver) =>
        this.guarded(null, () => driver.sweepVolumes(live)),
      ),
    ]);
  }

  start(slot: PoolSlot): void {
    if (this.stopping) return;
    const existing = this.entries.get(slot.client_id);
    if (existing) {
      existing.slot = slot;
      if (existing.requested === SlotControl.Drain && !slot.draining)
        existing.resume = true;
      return;
    }
    const pending = this.started() >= this.options.slotLimit;
    if (pending)
      this.options.logger.warn(
        {
          project_id: slot.project_id,
          binding: slot.resource_identity,
          slot: slot.slot,
        },
        "worker.pool.slot_limit",
      );
    const entry: Entry = {
      slot,
      pending,
      requested: null,
      resume: false,
      failure: null,
      delay: POOL_BACKOFF_INITIAL_MS,
      startedAt: 0,
      exit: Promise.withResolvers<void>(),
    };
    this.entries.set(slot.client_id, entry);
    if (!pending) this.launch(entry);
  }

  drain(slot: PoolSlot): void {
    const entry = this.entries.get(slot.client_id);
    if (!entry) {
      this.ended(slot.client_id);
      return;
    }
    entry.slot = slot;
    entry.resume = false;
    if (
      entry.pending &&
      this.options.runtimeIdentity(slot.client_id) === undefined
    ) {
      this.entries.delete(slot.client_id);
      this.ended(slot.client_id);
      return;
    }
    if (entry.instance && entry.requested !== SlotControl.Drain) {
      entry.requested = SlotControl.Drain;
      entry.instance.control(SlotControl.Drain);
    }
  }

  restart(slot: PoolSlot): void {
    const entry = this.entries.get(slot.client_id);
    if (!entry) return;
    slot.draining = true;
    this.drain(slot);
    entry.resume = true;
  }

  imageOf(slot: PoolSlot): string | null {
    return this.driver(slot.placement).imageOf?.(slot.client_id) ?? null;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(
      Array.from(this.entries.values(), (entry) => this.halt(entry)),
    );
  }

  private started(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (!entry.pending) count++;
    return count;
  }

  private promote(): void {
    if (this.stopping || this.started() >= this.options.slotLimit) return;
    let next: Entry | undefined;
    for (const candidate of this.entries.values())
      if (candidate.pending && (!next || candidate.slot.slot < next.slot.slot))
        next = candidate;
    if (!next) return;
    next.pending = false;
    this.launch(next);
  }

  private async halt(entry: Entry): Promise<void> {
    clearTimeout(entry.timer);
    const instance = entry.instance;
    if (!instance) {
      this.entries.delete(entry.slot.client_id);
      return;
    }
    entry.requested = SlotControl.Stop;
    instance.control(SlotControl.Stop);
    const deadline = setTimeout(() => {
      instance.terminate();
    }, POOL_STOP_DEADLINE_MS);
    try {
      await entry.exit.promise;
    } finally {
      clearTimeout(deadline);
    }
  }

  private workersDirectory(): string {
    return join(this.options.stateDirectory, WORKERS_DIRECTORY);
  }

  private root(slot: PoolSlot): string {
    return join(this.workersDirectory(), slot.client_id);
  }

  private removeRoot(clientId: string): Promise<void> {
    return rm(join(this.workersDirectory(), clientId), {
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
    clientId: string | null,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      this.options.logger.error(
        {
          err: error instanceof Error ? error : new Error(String(error)),
          client_id: clientId ?? undefined,
        },
        "worker.pool.cleanup_failed",
      );
    }
  }

  private token(slot: PoolSlot): Promise<string> {
    return generateSlotJWT(this.options.masterKey, this.options.authVersion, {
      clientId: slot.client_id,
      projectId: slot.project_id,
      bindingName:
        slot.resource_identity.split(IDENTITY_SEPARATOR)[BINDING_NAME_INDEX]!,
      slot: slot.slot,
    }).then(({ token }) => token);
  }

  private driver(placement: PoolPlacement): SlotDriver {
    const driver = this.options.drivers.get(placement);
    if (!driver)
      throw new Error("worker pool: no slot driver for the placement");
    return driver;
  }

  private launch(entry: Entry): void {
    if (this.stopping) return;
    const { slot } = entry;
    try {
      const root = this.root(slot);
      ensureDirectory(root);
      const logPath = join(root, STDERR_LOG);
      const log = createWriteStream(logPath, {
        fd: openPrivate(
          logPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
        ),
      });
      entry.log = log;
      const { port1, port2 } = new MessageChannel();
      entry.port = port1;
      servePort(
        port1,
        this.options.invocation,
        () => this.token(slot),
        this.options.logger,
      );
      const instance = this.driver(slot.placement).launch({
        slot,
        channel: port2,
        client_secret: deriveClientSecret(
          this.options.masterKey,
          this.options.authVersion,
          slot.client_id,
        ),
        root,
        output: log,
        environment: this.options.environment ?? process.env,
      });
      entry.instance = instance;
      entry.failure = null;
      entry.requested = null;
      entry.startedAt = Date.now();
      entry.exit = Promise.withResolvers<void>();
      void instance.exited.then(({ code, error }) => {
        if (error) entry.failure = error;
        this.exited(entry, code);
      });
      if (slot.draining) {
        entry.requested = SlotControl.Drain;
        instance.control(SlotControl.Drain);
      }
    } catch (error) {
      entry.failure = error instanceof Error ? error : new Error(String(error));
      this.exited(entry, 1);
    }
  }

  private exited(entry: Entry, code: number): void {
    entry.port?.close();
    entry.port = undefined;
    entry.log?.end();
    entry.log = undefined;
    entry.instance = undefined;
    const requested = entry.requested;
    entry.requested = null;
    entry.exit.resolve();
    if (this.stopping || requested === SlotControl.Stop) {
      this.entries.delete(entry.slot.client_id);
      return;
    }
    if (entry.resume) {
      entry.resume = false;
      entry.slot.draining = false;
      this.launch(entry);
      return;
    }
    const drained = requested === SlotControl.Drain && !entry.failure && !code;
    const unregistered =
      entry.slot.draining &&
      this.options.runtimeIdentity(entry.slot.client_id) === undefined;
    if (drained || unregistered) {
      this.entries.delete(entry.slot.client_id);
      this.ended(entry.slot.client_id);
      this.promote();
      return;
    }
    this.fail(entry, code);
  }

  private fail(entry: Entry, code: number): void {
    const { slot } = entry;
    this.options.logger.error(
      {
        err: entry.failure ?? undefined,
        exit_code: code,
        project_id: slot.project_id,
        binding: slot.resource_identity,
        slot: slot.slot,
        runtime_identity: this.options.runtimeIdentity(slot.client_id),
      },
      "worker.pool.instance_failed",
    );
    if (Date.now() - entry.startedAt >= POOL_BACKOFF_MAX_MS)
      entry.delay = POOL_BACKOFF_INITIAL_MS;
    const delay = entry.delay;
    entry.delay = Math.min(delay * BACKOFF_FACTOR, POOL_BACKOFF_MAX_MS);
    entry.timer = setTimeout(() => this.launch(entry), delay);
    entry.timer.unref();
  }

  private ended(clientId: string): void {
    for (const listener of this.listeners) listener(clientId);
  }
}
