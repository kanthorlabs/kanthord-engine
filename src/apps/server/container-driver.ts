import { spawn, type ChildProcessByStdio } from "node:child_process";
import { constants } from "node:os";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  ContainerRuntime,
  PoolPlacement,
  type PlacementStatus,
  type PoolSlot,
} from "../../worker/contract.ts";
import {
  bridgePort,
  FrameKind,
  instanceFrameSchema,
  writeFrame,
} from "../worker/frames.ts";
import type { SlotControl } from "../worker/thread-data.ts";
import {
  absentContainer,
  absentVolume,
  containerOwner,
  killArguments,
  ownedArguments,
  ownedVolumeArguments,
  presentVolume,
  removeArguments,
  removeVolumeArguments,
  runArguments,
  RUNTIME_CHECK_TIMEOUT_MS,
  slotClientId,
  slotName,
  SUCCESS_CODE,
  volumeArguments,
  detectRuntime,
  type RuntimeHost,
} from "./container-runtime.ts";
import type {
  SlotDriver,
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
const LINE_BREAK = /\r?\n/;

export interface ContainerDriverOptions {
  readonly masterKey: string;
  readonly image: string;
  readonly host: RuntimeHost;
  imageFor?(
    runtime: ContainerRuntime,
    slot: PoolSlot,
    signal: AbortSignal,
  ): Promise<string>;
}

interface StatusEntry {
  readonly answer: Promise<PlacementStatus>;
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

function linesOf(text: string): string[] {
  return text
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter(Boolean);
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
    this.name = slotName(launch.slot.client_id);
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
    await this.driver.createVolume(runtime, this.launch.slot.client_id);
    const image = await this.waitForImage(runtime);
    if (image === null) {
      this.finish(SUCCESS_CODE, null);
      return;
    }
    if (this.settled) return;
    this.spawn(runtime, image);
  }

  private waitForImage(runtime: ContainerRuntime): Promise<string | null> {
    const { signal } = this.waiting;
    return new Promise((resolve, reject) => {
      if (signal.aborted) return resolve(null);
      signal.addEventListener("abort", () => resolve(null), { once: true });
      this.driver.imageFor(runtime, this.launch.slot, signal).then(
        (image) => resolve(signal.aborted ? null : image),
        (error: unknown) => (signal.aborted ? resolve(null) : reject(error)),
      );
    });
  }

  private spawn(runtime: ContainerRuntime, image: string): void {
    const client = spawn(
      runtime,
      runArguments({
        image,
        clientId: this.launch.slot.client_id,
        owner: this.driver.owner,
        environment: this.launch.environment,
      }),
      {
        detached: true,
        env: this.launch.environment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.client = client;
    this.driver.recordImage(this.launch.slot.client_id, image);
    client.stdin.on("error", () => {});
    client.stderr.pipe(this.launch.output, { end: false });
    const closeBridge = bridgePort(
      this.launch.channel,
      client.stdout,
      client.stdin,
      {
        frames: instanceFrameSchema,
        onFrame: () => {},
        onInvalid: (error) => {
          this.error = error;
          this.terminate();
        },
        onEnd: () => {},
      },
    );
    writeFrame(client.stdin, {
      kind: FrameKind.Init,
      client_secret: this.launch.client_secret,
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
        closeBridge();
        this.finish(FAILED_CODE, error);
      }
    });
    client.once("close", (code, signal) => {
      clearInterval(ping);
      closeBridge();
      const exit = exitCode(code, signal);
      this.finish(exit, this.error ?? exitError(exit));
    });
  }

  private finish(code: number, error: Error | null): void {
    if (this.settled) return;
    this.settled = true;
    this.driver.forgetImage(this.launch.slot.client_id);
    this.settle({ code, error });
  }
}

export class ContainerDriver implements SlotDriver {
  readonly placement = PoolPlacement.Container;
  readonly image: string;
  readonly owner: string;
  private readonly host: RuntimeHost;
  private readonly resolveImage: ContainerDriverOptions["imageFor"];
  private latest: StatusEntry | null = null;
  private prepared: Promise<void> | null = null;
  private readonly images = new Map<string, string>();

  constructor(options: ContainerDriverOptions) {
    this.image = options.image;
    this.owner = containerOwner(options.masterKey);
    this.host = options.host;
    this.resolveImage = options.imageFor;
  }

  imageFor(
    runtime: ContainerRuntime,
    slot: PoolSlot,
    signal: AbortSignal,
  ): Promise<string> {
    return this.resolveImage
      ? this.resolveImage(runtime, slot, signal)
      : Promise.resolve(this.image);
  }

  imageOf(clientId: string): string | null {
    return this.images.get(clientId) ?? null;
  }

  recordImage(clientId: string, image: string): void {
    this.images.set(clientId, image);
  }

  forgetImage(clientId: string): void {
    this.images.delete(clientId);
  }

  check(): Promise<PlacementStatus> {
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

  async removeContainer(runtime: ContainerRuntime, name: string) {
    const answer = await this.command(runtime, removeArguments(name));
    if (!absentContainer(answer))
      throw commandFailure(`rm ${name}`, answer.stderr);
  }

  async createVolume(runtime: ContainerRuntime, clientId: string) {
    const answer = await this.command(
      runtime,
      volumeArguments(clientId, this.owner),
    );
    if (!presentVolume(answer))
      throw commandFailure(
        `volume create ${slotName(clientId)}`,
        answer.stderr,
      );
  }

  async removeVolume(clientId: string): Promise<void> {
    const runtime = await this.answeringRuntime();
    if (runtime === null) return;
    await this.removeVolumeOf(runtime, clientId);
  }

  async sweepVolumes(live: ReadonlySet<string>): Promise<void> {
    const runtime = await this.answeringRuntime();
    if (runtime === null) return;
    const answer = await this.command(
      runtime,
      ownedVolumeArguments(this.owner),
    );
    if (answer.code !== SUCCESS_CODE)
      throw commandFailure("volume ls", answer.stderr);
    for (const name of linesOf(answer.stdout)) {
      const clientId = slotClientId(name);
      if (clientId !== null && !live.has(clientId))
        await this.removeVolumeOf(runtime, clientId);
    }
  }

  private async answeringRuntime(): Promise<ContainerRuntime | null> {
    const status = await this.check();
    return status.available ? status.container_runtime : null;
  }

  private async removeVolumeOf(runtime: ContainerRuntime, clientId: string) {
    const answer = await this.command(runtime, removeVolumeArguments(clientId));
    if (!absentVolume(answer))
      throw commandFailure(`volume rm ${slotName(clientId)}`, answer.stderr);
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
