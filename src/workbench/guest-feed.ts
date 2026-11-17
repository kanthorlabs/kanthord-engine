import type { MemberEntry } from "./contract.ts";
import {
  WORKBENCH_STREAM_HEARTBEAT_MS,
  WORKBENCH_STREAM_QUEUE_BYTES,
  WORKBENCH_STREAM_TICK_MS,
} from "./contract.ts";
import {
  type GuestStreaming,
  projectEntries,
  projectStreaming,
} from "./guest-view.ts";

const NO_DELAY_MS = 0;
const NO_ITEMS = 0;
const NO_SPACE = 0;
const NEVER_PUBLISHED = Number.NEGATIVE_INFINITY;
const KEEPALIVE_COMMENT = ": keepalive\n\n";

const FrameEvent = { Entries: "entries", State: "state" } as const;
type FrameEvent = (typeof FrameEvent)[keyof typeof FrameEvent];

type Frame = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
const KEEPALIVE_FRAME = encoder.encode(KEEPALIVE_COMMENT);

export interface FeedState {
  run_active: boolean;
  display_name: string | null;
  auto_mode: boolean;
  streaming: Record<string, unknown> | null;
}

export interface GuestState {
  run_active: boolean;
  display_name: string | null;
  auto_mode: boolean;
  streaming: GuestStreaming | null;
}

export interface FeedSource {
  entries: (after: string | undefined) => MemberEntry[];
  state: () => FeedState;
}

export interface OpenStream {
  inviteId: string;
  expiresAt: number;
  after: string | undefined;
  signal: AbortSignal;
}

interface GuestStream {
  inviteId: string;
  controller: ReadableStreamDefaultController<Frame>;
  keepalive: NodeJS.Timeout;
  expiry: NodeJS.Timeout;
  detach: () => void;
}

function frameOf(event: FrameEvent, data: unknown): Frame {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function guestStateOf(state: FeedState): GuestState {
  return {
    run_active: state.run_active,
    display_name: state.display_name,
    auto_mode: state.auto_mode,
    streaming: projectStreaming(state.streaming),
  };
}

export class GuestFeed {
  version = 0;
  private readonly source: FeedSource;
  private readonly waiters = new Set<() => void>();
  private readonly streams = new Set<GuestStream>();
  private published = new Set<string>();
  private state: GuestState;
  private stateText: string;
  private timer: NodeJS.Timeout | null = null;
  private lastPublishAt = NEVER_PUBLISHED;
  private stopped = false;

  constructor(source: FeedSource) {
    this.source = source;
    this.state = guestStateOf(source.state());
    this.stateText = JSON.stringify(this.state);
  }

  subscribe(wake: () => void): () => void {
    this.waiters.add(wake);
    return () => {
      this.waiters.delete(wake);
    };
  }

  notify(): void {
    if (this.stopped || this.timer !== null) return;
    const wait = this.lastPublishAt + WORKBENCH_STREAM_TICK_MS - Date.now();
    this.timer = setTimeout(() => this.publish(), Math.max(NO_DELAY_MS, wait));
  }

  open(request: OpenStream): ReadableStream<Frame> {
    if (this.streams.size === NO_ITEMS) this.prime();
    let stream: GuestStream | undefined;
    const readable = new ReadableStream<Frame>(
      {
        start: (controller) => {
          stream = this.attach(controller, request);
        },
        cancel: () => {
          this.release(stream!);
        },
      },
      new ByteLengthQueuingStrategy({
        highWaterMark: WORKBENCH_STREAM_QUEUE_BYTES,
      }),
    );
    for (const frame of this.initialFrames(request.after))
      this.write(stream!, frame);
    return readable;
  }

  closeInvite(inviteId: string): void {
    for (const stream of [...this.streams])
      if (stream.inviteId === inviteId) this.close(stream);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const stream of [...this.streams]) this.close(stream);
  }

  private prime(): void {
    this.published = new Set(
      this.source.entries(undefined).map(({ id }) => id),
    );
    this.state = guestStateOf(this.source.state());
    this.stateText = JSON.stringify(this.state);
  }

  private initialFrames(after: string | undefined): Frame[] {
    const entries = projectEntries(
      this.source.entries(after).filter(({ id }) => this.published.has(id)),
    );
    return [
      ...(entries.length === NO_ITEMS
        ? []
        : [frameOf(FrameEvent.Entries, entries)]),
      frameOf(FrameEvent.State, this.state),
    ];
  }

  private attach(
    controller: ReadableStreamDefaultController<Frame>,
    request: OpenStream,
  ): GuestStream {
    const stream: GuestStream = {
      inviteId: request.inviteId,
      controller,
      keepalive: setInterval(
        () => this.write(stream, KEEPALIVE_FRAME),
        WORKBENCH_STREAM_HEARTBEAT_MS,
      ),
      expiry: setTimeout(
        () => this.close(stream),
        Math.max(NO_DELAY_MS, request.expiresAt - Date.now()),
      ),
      detach: () => request.signal.removeEventListener("abort", onAbort),
    };
    const onAbort = () => this.close(stream);
    this.streams.add(stream);
    if (request.signal.aborted) queueMicrotask(onAbort);
    else request.signal.addEventListener("abort", onAbort, { once: true });
    return stream;
  }

  private publish(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.lastPublishAt = Date.now();
    this.version++;
    for (const wake of [...this.waiters]) wake();
    if (this.streams.size === NO_ITEMS) return;
    for (const frame of this.changedFrames())
      for (const stream of [...this.streams]) this.write(stream, frame);
  }

  private changedFrames(): Frame[] {
    const fresh = this.source
      .entries(undefined)
      .filter(({ id }) => !this.published.has(id));
    for (const { id } of fresh) this.published.add(id);
    const entries = projectEntries(fresh);
    const state = guestStateOf(this.source.state());
    const stateText = JSON.stringify(state);
    const stateChanged = stateText !== this.stateText;
    this.state = state;
    this.stateText = stateText;
    return [
      ...(entries.length === NO_ITEMS
        ? []
        : [frameOf(FrameEvent.Entries, entries)]),
      ...(stateChanged ? [frameOf(FrameEvent.State, state)] : []),
    ];
  }

  private write(stream: GuestStream, frame: Frame): void {
    if ((stream.controller.desiredSize ?? NO_SPACE) <= NO_SPACE)
      return this.close(stream);
    stream.controller.enqueue(frame);
  }

  private release(stream: GuestStream): boolean {
    if (!this.streams.delete(stream)) return false;
    clearInterval(stream.keepalive);
    clearTimeout(stream.expiry);
    stream.detach();
    return true;
  }

  private close(stream: GuestStream): void {
    if (this.release(stream)) stream.controller.close();
  }
}
