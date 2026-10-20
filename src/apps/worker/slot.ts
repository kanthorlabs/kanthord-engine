import { createWriteStream, mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";
import { MessageChannel, type Worker } from "node:worker_threads";
import { Diagnostic, diagnostic, diagnosticRows } from "../../kernel/errors.ts";
import { LogDestination } from "../../kernel/log.ts";
import { isObject, isString } from "../../kernel/values.ts";
import {
  bridgePort,
  FrameKind,
  frameInvalid,
  serverFrameSchema,
  type ServerFrame,
} from "./frames.ts";
import { SlotControl, type ThreadData } from "./thread-data.ts";
import { startThread } from "./thread-start.ts";

const INIT_DEADLINE_MS = 10000;
const FRAME_DEADLINE_MS = 15000;
const STOP_DEADLINE_MS = 5000;
const FLUSH_DEADLINE_MS = 2000;
const FRAME_DESCRIPTOR = 3;
const PRIVATE_DIRECTORY_MODE = 0o700;
const STOPPED_BEFORE_START = 0;
const SLOT_FAILURE = 1;
const UNKNOWN_ERROR_CODE = "system.operation.unknown";
const STOP_SIGNALS = ["SIGTERM", "SIGINT"] as const;

export interface SlotOptions {
  readonly input: Readable;
  readonly frames: Writable;
  readonly output: Writable;
  readonly env: NodeJS.ProcessEnv;
  readonly start: (data: ThreadData, env: NodeJS.ProcessEnv) => Worker;
  readonly initDeadlineMs: number;
  readonly frameDeadlineMs: number;
  readonly stopDeadlineMs: number;
}

function channelClosed(reason: string): Diagnostic {
  return new Diagnostic(
    "worker.slot.channel_closed",
    "slot: the slot channel closed.",
    { fields: [["reason", reason]] },
  );
}

function errorCode(error: unknown): string {
  const code: unknown = isObject(error) ? Reflect.get(error, "code") : null;
  return isString(code) ? code : UNKNOWN_ERROR_CODE;
}

function initAbsent(): Diagnostic {
  return new Diagnostic(
    "worker.slot.init_absent",
    "slot: no init frame arrived before the deadline.",
  );
}

export class SlotSession {
  readonly exited: Promise<number>;
  private readonly options: SlotOptions;
  private readonly channel = new MessageChannel();
  private settle: (code: number) => void = () => {};
  private settled = false;
  private thread?: Worker;
  private stopping = false;
  private lastFrame = performance.now();
  private readonly timers = new Set<NodeJS.Timeout>();
  private closeBridge: () => void = () => {};

  constructor(options: SlotOptions) {
    this.options = options;
    this.exited = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  start(): Promise<number> {
    this.createTemporaryDirectory();
    this.options.frames.on("error", () =>
      this.fail(channelClosed("the frame output failed")),
    );
    this.closeBridge = bridgePort(
      this.channel.port1,
      this.options.input,
      this.options.frames,
      {
        frames: serverFrameSchema,
        onFrame: (frame) => this.receive(frame),
        onInvalid: (error) => this.fail(error),
        onEnd: () => this.fail(channelClosed("stdin reached its end")),
      },
    );
    this.arm(this.options.initDeadlineMs, () => {
      if (!this.thread) this.fail(initAbsent());
    });
    this.watchFrames(this.options.frameDeadlineMs);
    return this.exited;
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    const thread = this.thread;
    if (!thread) return this.finish(STOPPED_BEFORE_START);
    thread.postMessage({ kind: SlotControl.Stop });
    this.arm(this.options.stopDeadlineMs, () => void thread.terminate());
  }

  private createTemporaryDirectory(): void {
    const directory = this.options.env.TMPDIR;
    if (directory && isAbsolute(directory))
      mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }

  private receive(frame: ServerFrame): void {
    this.lastFrame = performance.now();
    if (frame.kind === FrameKind.Init) return this.launch(frame.client_secret);
    if (!this.thread) throw frameInvalid("the first frame is no init frame");
    if (frame.kind === FrameKind.Control)
      this.thread.postMessage({ kind: frame.control });
  }

  private launch(clientSecret: string): void {
    if (this.thread) throw frameInvalid("a second init frame arrived");
    const thread = this.options.start(
      {
        port: this.channel.port2,
        client_secret: clientSecret,
        log: LogDestination.StandardError,
      },
      this.options.env,
    );
    this.thread = thread;
    thread.stdout.pipe(this.options.output, { end: false });
    thread.stderr.pipe(this.options.output, { end: false });
    thread.on("error", (error: unknown) =>
      this.options.output.write(
        `slot: the worker thread failed with ${errorCode(error)}.\n`,
      ),
    );
    thread.once("exit", (code) => this.finish(code));
  }

  private watchFrames(deadlineMs: number): void {
    const idle = performance.now() - this.lastFrame;
    this.arm(Math.max(deadlineMs - idle, 0), () => {
      if (performance.now() - this.lastFrame < deadlineMs)
        return this.watchFrames(deadlineMs);
      this.fail(channelClosed("no frame arrived before the deadline"));
    });
  }

  private arm(delayMs: number, expire: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      setImmediate(() => {
        if (!this.settled) expire();
      });
    }, delayMs);
    this.timers.add(timer);
  }

  private fail(error: Diagnostic): void {
    if (this.settled) return;
    this.options.output.write(`${diagnostic(error)}\n${diagnosticRows(error)}`);
    this.finish(SLOT_FAILURE);
  }

  private finish(code: number): void {
    if (this.settled) return;
    this.settled = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.closeBridge();
    this.settle(code);
  }
}

function flush(frames: Writable): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FLUSH_DEADLINE_MS);
    frames.end(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function runSlot(
  overrides: Partial<SlotOptions> = {},
): Promise<void> {
  const frames = createWriteStream("", { fd: FRAME_DESCRIPTOR });
  const session = new SlotSession({
    input: process.stdin,
    frames,
    output: process.stderr,
    env: process.env,
    start: startThread,
    initDeadlineMs: INIT_DEADLINE_MS,
    frameDeadlineMs: FRAME_DEADLINE_MS,
    stopDeadlineMs: STOP_DEADLINE_MS,
    ...overrides,
  });
  for (const signal of STOP_SIGNALS) process.on(signal, () => session.stop());
  const code = await session.start();
  await flush(frames);
  process.exit(code);
}
