import { type ChildProcessByStdio, spawn } from "node:child_process";
import { lstatSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { constants } from "node:os";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import type { MessagePort } from "node:worker_threads";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  audit,
  FileKind,
  PRIVATE_DIRECTORY_MODE,
  readPrivate,
  writePrivate,
} from "../../kernel/files.ts";
import type {
  ContainerRuntime,
  RuntimeStoreInfo,
  RuntimeUsage,
} from "../../worker/contract.ts";
import {
  type PlacementStatus,
  type PoolEntry,
  PoolPlacement,
} from "../../worker/contract.ts";
import {
  type Bridge,
  bridgePort,
  type FrameEntry,
  FrameKind,
  instanceFrameSchema,
  writeFrame,
} from "../worker/frames.ts";
import type { SlotControl } from "../worker/thread-data.ts";
import {
  absentImage,
  absentVolume,
  cacheOwnerArguments,
  cacheVolumeArguments,
  cacheVolumeName,
  CONTAINER_SESSIONS_DIRECTORY,
  containerOwner,
  containerRemovalFailure,
  detectRuntime,
  IdMap,
  idMapOf,
  infoArguments,
  inspectVolumeArguments,
  killArguments,
  linesOf,
  migrateName,
  migrationArguments,
  NO_TIME_LIMIT_MS,
  ownedArguments,
  ownedVolumeArguments,
  parseRuntimeStore,
  parseSystemUsage,
  parseVolume,
  presentVolume,
  removeImageArguments,
  removeVolumeArguments,
  runArguments,
  RUNTIME_CHECK_TIMEOUT_MS,
  type RuntimeAnswer,
  type RuntimeCheck,
  type RuntimeFacts,
  type RuntimeHost,
  slotInstanceName,
  slotName,
  SUCCESS_CODE,
  systemUsageArguments,
  unshareMarkerArguments,
  unshareMigrationArguments,
  unshareOwnerArguments,
  volumeArguments,
  type VolumeState,
} from "./container-runtime.ts";
import type {
  SlotDriver,
  SlotEntry,
  SlotExit,
  SlotInstance,
  SlotLaunch,
} from "./slot-driver.ts";

export const STATUS_LIFETIME_MS = 10000;
export const PING_INTERVAL_MS = 5000;
export const CLIENT_KILL_DELAY_MS = 2000;
const FAILED_CODE = 1;
const SIGNAL_CODE_BASE = 128;
const RUNTIME_ERROR_CODE = 125;
const NOT_EXECUTABLE_CODE = 126;
const NOT_FOUND_CODE = 127;
export const SESSION_VOLUME_MARKER = "sessions.volume";
export const CACHE_OWNER_RECORD_SUFFIX = ".owner";
const PARTIAL_SESSIONS_DIRECTORY = "sessions.partial";
const VOLUMES_DIRECTORY = "volumes";

export interface ContainerDriverOptions {
  readonly masterKey: string;
  readonly image: string;
  readonly host: RuntimeHost;
  readonly stateDirectory: string;
  imageFor?(
    runtime: ContainerRuntime,
    entries: readonly PoolEntry[],
    signal: AbortSignal,
  ): Promise<string>;
  cacheGroupOf?(entries: readonly PoolEntry[], image: string): string | null;
}

interface StatusEntry {
  readonly answer: Promise<RuntimeCheck>;
  settledAt: number | null;
}

type RuntimeClient = ChildProcessByStdio<Writable, Readable, Readable>;

function unavailable(status: PlacementStatus): Diagnostic {
  return new Diagnostic(
    "worker.pool.driver_unavailable",
    "container: the container runtime is not available.",
    {
      fields: [
        ["placement", status.placement],
        ["reason", status.reason ?? ""],
        ["detail", status.detail ?? ""],
      ],
    },
  );
}

function commandFailure(action: string, stderr: string): Error {
  return new Error(`container: ${action} failed: ${stderr.trim()}`);
}

function exitError(code: number): Error | null {
  if (code === RUNTIME_ERROR_CODE)
    return new Error(
      "container: the runtime refused the run command; stderr.log holds its text",
    );
  if (code === NOT_EXECUTABLE_CODE || code === NOT_FOUND_CODE)
    return new Error(
      "container: the image command cannot run; stderr.log holds the runtime text",
    );
  return null;
}

function presentDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function recorded(path: string): string | null {
  return audit(path, FileKind.File, true) ? readPrivate(path) : null;
}

function frameEntries(entries: readonly SlotEntry[]): FrameEntry[] {
  return entries.map(({ client_id, client_secret, state }) => ({
    client_id,
    client_secret,
    state,
  }));
}

function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return signal === null
    ? FAILED_CODE
    : SIGNAL_CODE_BASE + constants.signals[signal];
}

class ContainerInstance implements SlotInstance {
  readonly exited: Promise<SlotExit>;
  private readonly driver: ContainerDriver;
  private readonly launch: SlotLaunch;
  private readonly name: string;
  private readonly channels = new Map<string, MessagePort>();
  private entries: readonly SlotEntry[];
  private bridge: Bridge | null = null;
  private readonly queued: SlotControl["kind"][] = [];
  private readonly waiting = new AbortController();
  private settle: (exit: SlotExit) => void = () => {};
  private settled = false;
  private terminating = false;
  private runtime: ContainerRuntime | null = null;
  private client: RuntimeClient | null = null;
  private error: Error | null = null;

  constructor(driver: ContainerDriver, launch: SlotLaunch) {
    this.driver = driver;
    this.launch = launch;
    this.name = slotName(launch.instance.name);
    this.entries = launch.entries;
    this.remember(launch.entries);
    this.exited = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.start().catch((error: unknown) => {
      this.finish(
        FAILED_CODE,
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  }

  control(kind: SlotControl["kind"]): void {
    this.waiting.abort();
    if (this.client)
      writeFrame(this.client.stdin, { kind: FrameKind.Control, control: kind });
    else this.queued.push(kind);
  }

  bindings(entries: readonly SlotEntry[]): void {
    this.entries = entries;
    this.remember(entries);
    if (!this.client || !this.bridge) return;
    this.attach(this.bridge);
    writeFrame(this.client.stdin, {
      kind: FrameKind.Bindings,
      entries: frameEntries(entries),
    });
  }

  private remember(entries: readonly SlotEntry[]): void {
    for (const entry of entries)
      if (entry.channel) this.channels.set(entry.client_id, entry.channel);
  }

  private attach(bridge: Bridge): void {
    for (const { client_id } of this.entries) {
      const channel = this.channels.get(client_id);
      if (channel && !bridge.has(client_id)) bridge.attach(client_id, channel);
    }
  }

  terminate(): void {
    if (this.settled || this.terminating) return;
    this.terminating = true;
    this.waiting.abort();
    const client = this.client;
    if (!client || this.runtime === null) {
      this.finish(FAILED_CODE, new Error("container: terminated before start"));
      return;
    }
    void this.driver.command(this.runtime, killArguments(this.name));
    const timer = setTimeout(() => {
      if (client.exitCode === null && client.signalCode === null)
        client.kill("SIGKILL");
    }, CLIENT_KILL_DELAY_MS);
    timer.unref();
  }

  private async start(): Promise<void> {
    const runtime = await this.driver.runtime();
    this.runtime = runtime;
    await this.driver.prepare();
    await this.driver.removeContainer(runtime, this.name);
    await this.driver.removeContainer(
      runtime,
      migrateName(this.launch.instance.name),
    );
    await this.driver.createVolume(runtime, this.launch.instance.name);
    const image = await this.waitForImage(runtime);
    if (image === null) {
      this.finish(SUCCESS_CODE, null);
      return;
    }
    if (this.settled) return;
    const facts = await this.driver.facts();
    if (facts === null) throw unavailable(await this.driver.check());
    await this.migrate(runtime, image, facts);
    if (this.stopped()) return;
    const cacheVolume = await this.cacheVolumeFor(runtime, image);
    if (this.stopped()) return;
    await this.driver.shared(() => {
      if (this.stopped()) return Promise.resolve();
      return this.spawn(runtime, image, cacheVolume, facts);
    });
  }

  private stopped(): boolean {
    if (this.settled) return true;
    if (!this.waiting.signal.aborted) return false;
    this.finish(SUCCESS_CODE, null);
    return true;
  }

  private async migrate(
    runtime: ContainerRuntime,
    image: string,
    facts: RuntimeFacts,
  ): Promise<void> {
    const { root } = this.launch;
    const sessions = join(root, CONTAINER_SESSIONS_DIRECTORY);
    const marker = join(root, SESSION_VOLUME_MARKER);
    const present = presentDirectory(sessions);
    const volume = await this.driver.inspectVolume(runtime, this.name);
    if (present && recorded(marker) === volume.createdAt) return;
    const mount = present ? sessions : join(root, PARTIAL_SESSIONS_DIRECTORY);
    if (!present)
      mkdirSync(mount, { mode: PRIVATE_DIRECTORY_MODE, recursive: true });
    const answer = await this.driver.runMigration(runtime, {
      image,
      instanceName: this.launch.instance.name,
      mount,
      facts,
      volume,
      signal: this.waiting.signal,
    });
    if (this.waiting.signal.aborted) return;
    if (answer.code !== SUCCESS_CODE)
      throw commandFailure("session migration", answer.stderr);
    writePrivate(marker, volume.createdAt, true);
    if (!present) renameSync(mount, sessions);
  }

  private async cacheVolumeFor(
    runtime: ContainerRuntime,
    image: string,
  ): Promise<string | null> {
    const group = this.driver.cacheGroupOf(this.entries, image);
    const first = this.entries.at(0);
    if (group === null || !first) return null;
    const name = await this.driver.createCacheVolume(
      runtime,
      first.project_id,
      group,
    );
    await this.driver.prepareCacheVolume(
      runtime,
      name,
      image,
      this.waiting.signal,
    );
    return name;
  }

  private waitForImage(runtime: ContainerRuntime): Promise<string | null> {
    const { signal } = this.waiting;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return resolve(null);
      signal.addEventListener("abort", () => resolve(null), { once: true });
      this.driver.imageFor(runtime, this.entries, signal).then(
        (image) => resolve(signal.aborted ? null : image),
        (error: unknown) => (signal.aborted ? resolve(null) : reject(error)),
      );
    });
  }

  private spawn(
    runtime: ContainerRuntime,
    image: string,
    cacheVolume: string | null,
    facts: RuntimeFacts,
  ): Promise<void> {
    const started = Promise.withResolvers<void>();
    const client = spawn(
      runtime,
      runArguments({
        image,
        instanceName: this.launch.instance.name,
        owner: this.driver.owner,
        environment: this.launch.environment,
        cacheVolume,
        sessionDirectory: join(this.launch.root, CONTAINER_SESSIONS_DIRECTORY),
        rootless: idMapOf(runtime, facts, true) === IdMap.Auto,
        selinux: facts.selinux,
      }),
      {
        detached: true,
        env: this.launch.environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.client = client;
    this.driver.recordImage(this.launch.instance.name, image);
    client.stdin.on("error", () => {});
    client.stderr.pipe(this.launch.output, { end: false });
    const bridge = bridgePort(client.stdout, client.stdin, {
      frames: instanceFrameSchema,
      onFrame: () => started.resolve(),
      onInvalid: (error) => {
        this.error = error;
        this.terminate();
      },
      onEnd: () => {},
    });
    this.bridge = bridge;
    this.attach(bridge);
    writeFrame(client.stdin, {
      kind: FrameKind.Init,
      entries: frameEntries(this.entries),
    });
    for (const kind of this.queued.splice(0))
      writeFrame(client.stdin, { kind: FrameKind.Control, control: kind });
    const ping = setInterval(() => {
      writeFrame(client.stdin, { kind: FrameKind.Ping });
    }, PING_INTERVAL_MS);
    ping.unref();
    client.once("error", (error) => {
      if (client.pid === undefined) {
        clearInterval(ping);
        bridge.close();
        started.resolve();
        this.finish(FAILED_CODE, error);
      }
    });
    client.once("close", (code, signal) => {
      clearInterval(ping);
      bridge.close();
      started.resolve();
      const exit = exitCode(code, signal);
      this.finish(exit, this.error ?? exitError(exit));
    });
    return started.promise;
  }

  private finish(code: number, error: Error | null): void {
    if (this.settled) return;
    this.settled = true;
    this.driver.forgetImage(this.launch.instance.name);
    this.settle({ code, error });
  }
}

interface Migration {
  readonly image: string;
  readonly instanceName: string;
  readonly mount: string;
  readonly facts: RuntimeFacts;
  readonly volume: VolumeState;
  readonly signal: AbortSignal;
}

class IdMapGate {
  private sharedRuns = 0;
  private exclusiveRun = false;
  private exclusiveWaits = 0;
  private waiters: Array<() => void> = [];

  async shared<T>(run: () => Promise<T>): Promise<T> {
    while (this.exclusiveRun || this.exclusiveWaits) await this.changed();
    this.sharedRuns++;
    try {
      return await run();
    } finally {
      this.sharedRuns--;
      this.wake();
    }
  }

  async exclusive<T>(run: () => Promise<T>): Promise<T> {
    this.exclusiveWaits++;
    try {
      while (this.exclusiveRun || this.sharedRuns) await this.changed();
    } finally {
      this.exclusiveWaits--;
    }
    this.exclusiveRun = true;
    try {
      return await run();
    } finally {
      this.exclusiveRun = false;
      this.wake();
    }
  }

  private changed(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

export class ContainerDriver implements SlotDriver {
  readonly placement = PoolPlacement.Container;
  readonly image: string;
  readonly owner: string;
  private readonly host: RuntimeHost;
  private readonly resolveImage: ContainerDriverOptions["imageFor"];
  private readonly resolveCacheGroup: ContainerDriverOptions["cacheGroupOf"];
  private readonly stateDirectory: string;
  private latest: StatusEntry | null = null;
  private prepared: Promise<void> | null = null;
  private readonly images = new Map<string, string>();
  private readonly gate = new IdMapGate();

  constructor(options: ContainerDriverOptions) {
    this.image = options.image;
    this.owner = containerOwner(options.masterKey);
    this.host = options.host;
    this.stateDirectory = options.stateDirectory;
    this.resolveImage = options.imageFor;
    this.resolveCacheGroup = options.cacheGroupOf;
  }

  cacheGroupOf(entries: readonly PoolEntry[], image: string): string | null {
    return this.resolveCacheGroup?.(entries, image) ?? null;
  }

  imageFor(
    runtime: ContainerRuntime,
    entries: readonly PoolEntry[],
    signal: AbortSignal,
  ): Promise<string> {
    return this.resolveImage
      ? this.resolveImage(runtime, entries, signal)
      : Promise.resolve(this.image);
  }

  imageOf(instanceName: string): string | null {
    return this.images.get(instanceName) ?? null;
  }

  recordImage(instanceName: string, image: string): void {
    this.images.set(instanceName, image);
  }

  forgetImage(instanceName: string): void {
    this.images.delete(instanceName);
  }

  check(): Promise<PlacementStatus> {
    return this.detected().then(({ status }) => status);
  }

  facts(): Promise<RuntimeFacts | null> {
    return this.detected().then(({ facts }) => facts);
  }

  exclusive<T>(run: () => Promise<T>): Promise<T> {
    return this.gate.exclusive(run);
  }

  shared<T>(run: () => Promise<T>): Promise<T> {
    return this.gate.shared(run);
  }

  private detected(): Promise<RuntimeCheck> {
    const latest = this.latest;
    if (
      latest &&
      (latest.settledAt === null ||
        performance.now() - latest.settledAt < STATUS_LIFETIME_MS)
    )
      return latest.answer;
    const entry: StatusEntry = {
      answer: detectRuntime(this.host),
      settledAt: null,
    };
    this.latest = entry;
    void entry.answer.then(() => {
      entry.settledAt = performance.now();
    });
    return entry.answer;
  }

  prepare(): Promise<void> {
    this.prepared ??= this.removeOwned().then(
      (answered) => {
        if (!answered) this.prepared = null;
      },
      (error: unknown) => {
        this.prepared = null;
        throw error;
      },
    );
    return this.prepared;
  }

  launch(launch: SlotLaunch): SlotInstance {
    return new ContainerInstance(this, launch);
  }

  async runtime(): Promise<ContainerRuntime> {
    const status = await this.check();
    if (!status.available || status.container_runtime === null)
      throw unavailable(status);
    return status.container_runtime;
  }

  command(runtime: ContainerRuntime, args: readonly string[]) {
    return this.host.run(runtime, args, RUNTIME_CHECK_TIMEOUT_MS);
  }

  async runtimeUsage(): Promise<RuntimeUsage | null> {
    const runtime = await this.answeringRuntime();
    if (runtime === null) return null;
    const answer = await this.command(runtime, systemUsageArguments());
    if (answer.code !== SUCCESS_CODE)
      throw commandFailure("system df", answer.stderr);
    return parseSystemUsage(runtime, answer.stdout);
  }

  async runtimeStore(): Promise<RuntimeStoreInfo | null> {
    const runtime = await this.answeringRuntime();
    if (runtime === null) return null;
    const answer = await this.command(runtime, infoArguments());
    if (answer.code !== SUCCESS_CODE)
      throw commandFailure("info", answer.stderr);
    return parseRuntimeStore(runtime, answer.stdout);
  }

  async removeImage(reference: string): Promise<boolean> {
    const runtime = await this.answeringRuntime();
    if (runtime === null) return false;
    const answer = await this.command(runtime, removeImageArguments(reference));
    if (answer.code === SUCCESS_CODE) return true;
    if (absentImage(answer)) return false;
    throw commandFailure(`image rm ${reference}`, answer.stderr);
  }

  async removeContainer(runtime: ContainerRuntime, name: string) {
    const failed = await containerRemovalFailure(
      (args) => this.command(runtime, args),
      name,
    );
    if (failed !== null) throw commandFailure(`rm ${name}`, failed.stderr);
  }

  async createVolume(runtime: ContainerRuntime, instanceName: string) {
    const answer = await this.command(
      runtime,
      volumeArguments(instanceName, this.owner),
    );
    if (!presentVolume(answer))
      throw commandFailure(
        `volume create ${slotName(instanceName)}`,
        answer.stderr,
      );
  }

  async createCacheVolume(
    runtime: ContainerRuntime,
    projectId: string,
    resourceIdentity: string,
  ): Promise<string> {
    const name = cacheVolumeName(this.owner, projectId, resourceIdentity);
    const answer = await this.command(
      runtime,
      cacheVolumeArguments(this.owner, projectId, resourceIdentity),
    );
    if (!presentVolume(answer))
      throw commandFailure(`volume create ${name}`, answer.stderr);
    return name;
  }

  async inspectVolume(
    runtime: ContainerRuntime,
    name: string,
  ): Promise<VolumeState> {
    const answer = await this.command(runtime, inspectVolumeArguments([name]));
    if (answer.code !== SUCCESS_CODE)
      throw commandFailure(`volume inspect ${name}`, answer.stderr);
    return parseVolume(answer.stdout);
  }

  runMigration(
    runtime: ContainerRuntime,
    migration: Migration,
  ): Promise<RuntimeAnswer> {
    const idMap = idMapOf(runtime, migration.facts, migration.volume.labeled);
    if (idMap === IdMap.Unshare)
      return this.unbounded(
        runtime,
        unshareMigrationArguments(migration.volume.mountPoint, migration.mount),
        migration.signal,
      );
    const args = migrationArguments({
      image: migration.image,
      instanceName: migration.instanceName,
      owner: this.owner,
      mount: migration.mount,
      idMap,
      facts: migration.facts,
    });
    const run = () =>
      this.unbounded(
        runtime,
        args,
        migration.signal,
        migrateName(migration.instanceName),
      );
    return idMap === IdMap.KeepId ? this.exclusive(run) : this.shared(run);
  }

  async prepareCacheVolume(
    runtime: ContainerRuntime,
    name: string,
    image: string,
    signal: AbortSignal,
  ): Promise<void> {
    const facts = await this.facts();
    if (facts === null || idMapOf(runtime, facts, true) !== IdMap.Auto) return;
    const volume = await this.inspectVolume(runtime, name);
    const record = join(
      this.stateDirectory,
      VOLUMES_DIRECTORY,
      `${name}${CACHE_OWNER_RECORD_SUFFIX}`,
    );
    if (recorded(record) === volume.createdAt) return;
    const changed = await this.ownCacheVolume(
      runtime,
      name,
      image,
      volume,
      idMapOf(runtime, facts, volume.labeled),
      signal,
    );
    if (changed) writePrivate(record, volume.createdAt, true);
  }

  private async ownCacheVolume(
    runtime: ContainerRuntime,
    name: string,
    image: string,
    volume: VolumeState,
    idMap: IdMap,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (idMap === IdMap.Unshare)
      return (
        (await this.requireUnbounded(
          runtime,
          unshareOwnerArguments(volume.mountPoint),
          signal,
        )) &&
        (await this.requireUnbounded(
          runtime,
          unshareMarkerArguments(volume.mountPoint),
          signal,
        ))
      );
    const keepId = idMap === IdMap.KeepId;
    return this.requireUnbounded(
      runtime,
      cacheOwnerArguments({
        image,
        owner: this.owner,
        volume: name,
        idMap: keepId ? IdMap.KeepId : IdMap.Auto,
      }),
      signal,
      keepId ? this.exclusive.bind(this) : this.shared.bind(this),
    );
  }

  private async requireUnbounded(
    runtime: ContainerRuntime,
    args: readonly string[],
    signal: AbortSignal,
    hold: <T>(run: () => Promise<T>) => Promise<T> = (run) => run(),
  ): Promise<boolean> {
    const answer = await hold(() => this.unbounded(runtime, args, signal));
    if (signal.aborted) return false;
    if (answer.code !== SUCCESS_CODE)
      throw commandFailure("cache volume owner", answer.stderr);
    return true;
  }

  private unbounded(
    runtime: ContainerRuntime,
    args: readonly string[],
    signal: AbortSignal,
    container?: string,
  ): Promise<RuntimeAnswer> {
    const kill = () => {
      if (container !== undefined)
        void this.command(runtime, killArguments(container));
    };
    signal.addEventListener("abort", kill, { once: true });
    return this.host
      .run(runtime, args, NO_TIME_LIMIT_MS, signal)
      .finally(() => signal.removeEventListener("abort", kill));
  }

  async removeVolume(instanceName: string): Promise<void> {
    const runtime = await this.answeringRuntime();
    if (runtime === null) return;
    await this.removeVolumeOf(runtime, instanceName);
  }

  async sweepVolumes(archived: ReadonlySet<string>): Promise<void> {
    const runtime = await this.answeringRuntime();
    if (runtime === null) return;
    const answer = await this.command(
      runtime,
      ownedVolumeArguments(this.owner),
    );
    if (answer.code !== SUCCESS_CODE)
      throw commandFailure("volume ls", answer.stderr);
    for (const name of linesOf(answer.stdout)) {
      const instanceName = slotInstanceName(name);
      if (instanceName !== null && archived.has(instanceName))
        await this.removeVolumeOf(runtime, instanceName);
    }
  }

  private async answeringRuntime(): Promise<ContainerRuntime | null> {
    const status = await this.check();
    return status.available ? status.container_runtime : null;
  }

  private async removeVolumeOf(
    runtime: ContainerRuntime,
    instanceName: string,
  ) {
    const answer = await this.command(
      runtime,
      removeVolumeArguments(instanceName),
    );
    if (!absentVolume(answer))
      throw commandFailure(
        `volume rm ${slotName(instanceName)}`,
        answer.stderr,
      );
  }

  private async removeOwned(): Promise<boolean> {
    const runtime = await this.answeringRuntime();
    if (runtime === null) return false;
    const answer = await this.command(runtime, ownedArguments(this.owner));
    if (answer.code !== SUCCESS_CODE) throw commandFailure("ps", answer.stderr);
    for (const name of linesOf(answer.stdout))
      await this.removeContainer(runtime, name);
    return true;
  }
}
