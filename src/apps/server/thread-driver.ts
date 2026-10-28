import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { LogDestination } from "../../kernel/log.ts";
import { type PlacementStatus, PoolPlacement } from "../../worker/contract.ts";
import { startThread } from "../worker/thread-start.ts";
import {
  entryPorts,
  type SlotControl,
  type ThreadEntry,
  ThreadMessageKind,
} from "../worker/thread-data.ts";
import type {
  SlotDriver,
  SlotEntry,
  SlotExit,
  SlotInstance,
  SlotLaunch,
} from "./slot-driver.ts";

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

function threadEntries(entries: readonly SlotEntry[]): ThreadEntry[] {
  return entries.map((entry) => ({
    client_id: entry.client_id,
    port: entry.channel,
    client_secret: entry.client_secret,
    state: entry.state,
  }));
}

class ThreadInstance implements SlotInstance {
  readonly exited: Promise<SlotExit>;
  private readonly worker: Worker;

  constructor(worker: Worker, onExit: () => void) {
    this.worker = worker;
    let error: Error | null = null;
    worker.on("error", (cause: unknown) => {
      error = cause instanceof Error ? cause : new Error(String(cause));
    });
    this.exited = new Promise((resolve) => {
      worker.once("exit", (code) => {
        onExit();
        resolve({ code, error });
      });
    });
  }

  control(kind: SlotControl["kind"]): void {
    this.worker.postMessage({ kind });
  }

  bindings(entries: readonly SlotEntry[]): void {
    const wire = threadEntries(entries);
    this.worker.postMessage(
      { kind: ThreadMessageKind.Bindings, entries: wire },
      entryPorts(wire),
    );
  }

  terminate(): void {
    void this.worker.terminate();
  }
}

export class ThreadDriver implements SlotDriver {
  readonly placement = PoolPlacement.Server;
  private readonly threads = new Map<string, Worker>();

  check(): Promise<PlacementStatus> {
    return Promise.resolve({
      placement: this.placement,
      available: true,
      reason: null,
      detail: null,
      container_runtime: null,
    });
  }

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  removeVolume(): Promise<void> {
    return Promise.resolve();
  }

  sweepVolumes(): Promise<void> {
    return Promise.resolve();
  }

  launch(launch: SlotLaunch): SlotInstance {
    const name = launch.instance.name;
    const worker = startThread(
      {
        entries: threadEntries(launch.entries),
        log: LogDestination.File,
      },
      threadEnvironment(launch.environment, launch.root),
    );
    worker.stdout.pipe(launch.output, { end: false });
    worker.stderr.pipe(launch.output, { end: false });
    this.threads.set(name, worker);
    return new ThreadInstance(worker, () => {
      if (this.threads.get(name) === worker) this.threads.delete(name);
    });
  }

  threadOf(instanceName: string): Worker | undefined {
    return this.threads.get(instanceName);
  }
}
