import { constants, createWriteStream, type WriteStream } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import type { Logger } from "pino";
import { generateSlotJWT, deriveClientSecret } from "../../gateway/auth/jwt.ts";
import { servePort, type createInvocation } from "../../gateway/index.ts";
import { workerThreadAsset } from "../../kernel/assets.ts";
import { ensureDirectory, openPrivate } from "../../kernel/files.ts";
import { LogDestination } from "../../kernel/log.ts";
import type { PoolHost, PoolSlot } from "../../worker/contract.ts";
import { slotClientIdentity } from "./slot-identity.ts";

export const POOL_BACKOFF_INITIAL_MS = 1000;
export const POOL_BACKOFF_MAX_MS = 30000;
export const POOL_STOP_DEADLINE_MS = 5000;
const BACKOFF_FACTOR = 2;
const WORKERS_DIRECTORY = "workers";
const STDERR_LOG = "stderr.log";
const BINDING_NAME_INDEX = 2;
const IDENTITY_SEPARATOR = ":";
const ThreadMessage = { Drain: "drain", Stop: "stop" } as const;
const INHERITED_VARIABLES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];
const SLOT_DIRECTORIES = {
  XDG_CONFIG_HOME: "config",
  XDG_STATE_HOME: "state",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
};

export interface WorkerPoolOptions {
  invocation: ReturnType<typeof createInvocation>;
  masterKey: string;
  authVersion: number;
  slotLimit: number;
  stateDirectory: string;
  logger: Logger;
  runtimeIdentity: (clientId: string) => string | undefined;
  environment?: NodeJS.ProcessEnv;
}

interface Entry {
  slot: PoolSlot;
  pending: boolean;
  worker?: Worker;
  port?: MessagePort;
  log?: WriteStream;
  requested: (typeof ThreadMessage)[keyof typeof ThreadMessage] | null;
  resume: boolean;
  failure: Error | null;
  delay: number;
  startedAt: number;
  timer?: NodeJS.Timeout;
  exit: PromiseWithResolvers<void>;
}

export function threadEnvironment(
  source: NodeJS.ProcessEnv,
  root: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of INHERITED_VARIABLES)
    if (source[name] !== undefined) env[name] = source[name];
  for (const [name, directory] of Object.entries(SLOT_DIRECTORIES))
    env[name] = join(root, directory);
  return env;
}

function threadEntry(): URL {
  return new URL(
    `../worker/thread${extname(import.meta.url)}`,
    import.meta.url,
  );
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

  threadOf(clientId: string): Worker | undefined {
    return this.entries.get(clientId)?.worker;
  }

  onEnded(listener: (clientId: string) => void): void {
    this.listeners.push(listener);
  }

  start(slot: PoolSlot): void {
    if (this.stopping) return;
    const existing = this.entries.get(slot.client_id);
    if (existing) {
      existing.slot = slot;
      if (existing.requested === ThreadMessage.Drain && !slot.draining)
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
    if (entry.worker && entry.requested !== ThreadMessage.Drain) {
      entry.requested = ThreadMessage.Drain;
      entry.worker.postMessage({ kind: ThreadMessage.Drain });
    }
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
    const worker = entry.worker;
    if (!worker) {
      this.entries.delete(entry.slot.client_id);
      return;
    }
    entry.requested = ThreadMessage.Stop;
    worker.postMessage({ kind: ThreadMessage.Stop });
    const deadline = setTimeout(() => {
      void worker.terminate();
    }, POOL_STOP_DEADLINE_MS);
    try {
      await entry.exit.promise;
    } finally {
      clearTimeout(deadline);
    }
  }

  private root(slot: PoolSlot): string {
    return join(this.options.stateDirectory, WORKERS_DIRECTORY, slot.client_id);
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
      const data = {
        port: port2,
        client_secret: deriveClientSecret(
          this.options.masterKey,
          this.options.authVersion,
          slot.client_id,
        ),
        log: LogDestination.File,
      };
      const workerOptions = {
        workerData: data,
        transferList: [port2],
        env: threadEnvironment(this.options.environment ?? process.env, root),
        stdout: true,
        stderr: true,
      };
      const bundle = workerThreadAsset();
      const worker =
        bundle === undefined
          ? new Worker(fileURLToPath(threadEntry()), workerOptions)
          : new Worker(bundle, { ...workerOptions, eval: true });
      worker.stdout.pipe(log, { end: false });
      worker.stderr.pipe(log, { end: false });
      entry.worker = worker;
      entry.failure = null;
      entry.requested = null;
      entry.startedAt = Date.now();
      entry.exit = Promise.withResolvers<void>();
      worker.on("error", (error: unknown) => {
        entry.failure =
          error instanceof Error ? error : new Error(String(error));
      });
      worker.once("exit", (code) => this.exited(entry, code));
      if (slot.draining) {
        entry.requested = ThreadMessage.Drain;
        worker.postMessage({ kind: ThreadMessage.Drain });
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
    entry.worker = undefined;
    const requested = entry.requested;
    entry.requested = null;
    entry.exit.resolve();
    if (this.stopping || requested === ThreadMessage.Stop) {
      this.entries.delete(entry.slot.client_id);
      return;
    }
    if (entry.resume) {
      entry.resume = false;
      entry.slot.draining = false;
      this.launch(entry);
      return;
    }
    const drained =
      requested === ThreadMessage.Drain && !entry.failure && !code;
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
