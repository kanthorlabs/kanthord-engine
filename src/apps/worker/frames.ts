import type { Readable, Writable } from "node:stream";
import type { MessagePort } from "node:worker_threads";
import { z } from "zod";
import { portAnswerSchema, type PortAnswer } from "../../gateway/client.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { SlotControl } from "./thread-data.ts";

const MEBIBYTE = 1024 * 1024;
export const FRAME_LINE_LIMIT_BYTES = 64 * MEBIBYTE;
const LINE_FEED = 0x0a;
const ABSENT = -1;
const INVALID_RESPONSE_STATUS = 500;

export const FrameKind = {
  Init: "init",
  Port: "port",
  Control: "control",
  Ping: "ping",
} as const;

const portFrameSchema = z.strictObject({
  kind: z.literal(FrameKind.Port),
  message: z.record(z.string(), z.unknown()),
});

export const serverFrameSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(FrameKind.Init),
    client_secret: z.string().min(1),
  }),
  portFrameSchema,
  z.strictObject({
    kind: z.literal(FrameKind.Control),
    control: z.enum(SlotControl),
  }),
  z.strictObject({ kind: z.literal(FrameKind.Ping) }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;

export const instanceFrameSchema = z.discriminatedUnion("kind", [
  portFrameSchema,
]);
export type InstanceFrame = z.infer<typeof instanceFrameSchema>;

export type Frame = ServerFrame | InstanceFrame;

export function frameInvalid(reason: string): Diagnostic {
  return new Diagnostic(
    "worker.slot.frame_invalid",
    "slot: a line of the slot channel is no valid frame.",
    { fields: [["reason", reason]] },
  );
}

export function encodeFrame(frame: Frame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function writeFrame(writable: Writable, frame: Frame): void {
  writable.write(encodeFrame(frame));
}

export class FrameDecoder {
  private readonly text = new TextDecoder("utf-8", { fatal: true });
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let rest = chunk;
    for (let end = rest.indexOf(LINE_FEED); end !== ABSENT;) {
      this.append(rest.subarray(0, end));
      lines.push(this.take());
      rest = rest.subarray(end + 1);
      end = rest.indexOf(LINE_FEED);
    }
    this.append(rest);
    return lines;
  }

  private append(piece: Buffer): void {
    this.pendingBytes += piece.length;
    if (this.pendingBytes > FRAME_LINE_LIMIT_BYTES)
      throw frameInvalid(`a line exceeds ${FRAME_LINE_LIMIT_BYTES} bytes`);
    if (piece.length) this.pending.push(piece);
  }

  private take(): string {
    const line = Buffer.concat(this.pending, this.pendingBytes);
    this.pending = [];
    this.pendingBytes = 0;
    try {
      return this.text.decode(line);
    } catch {
      throw frameInvalid("a line is no valid UTF-8");
    }
  }
}

export function decodeFrame<T extends Frame>(
  line: string,
  schema: z.ZodType<T>,
): T {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw frameInvalid("a line is no JSON");
  }
  const frame = schema.safeParse(value);
  if (!frame.success) throw frameInvalid("a line fails the frame schema");
  return frame.data;
}

function invalidResponse(callId: string): PortAnswer {
  return {
    call_id: callId,
    status: INVALID_RESPONSE_STATUS,
    body: {
      error: {
        code: "gateway.invocation.invalid_response",
        message: "Operation returned an invalid response.",
        details: null,
      },
      request_id: createIdentity("request"),
    },
  };
}

function portLine(message: unknown): string | null {
  try {
    return encodeFrame({
      kind: FrameKind.Port,
      message: message as Record<string, unknown>,
    });
  } catch {
    const answer = portAnswerSchema.safeParse(message);
    return answer.success
      ? encodeFrame({
          kind: FrameKind.Port,
          message: invalidResponse(answer.data.call_id),
        })
      : null;
  }
}

export interface BridgeOptions<T extends Frame> {
  readonly frames: z.ZodType<T>;
  readonly onFrame: (frame: T) => void;
  readonly onInvalid: (error: Diagnostic) => void;
  readonly onEnd: () => void;
}

export function bridgePort<T extends Frame>(
  port: MessagePort,
  readable: Readable,
  writable: Writable,
  options: BridgeOptions<T>,
): () => void {
  const decoder = new FrameDecoder();
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    readable.off("data", read);
    readable.off("end", end);
    readable.off("error", end);
    port.off("message", send);
  };
  const deliver = (line: string) => {
    const frame = decodeFrame(line, options.frames);
    options.onFrame(frame);
    if (open && frame.kind === FrameKind.Port) port.postMessage(frame.message);
  };
  const read = (chunk: Buffer | string) => {
    try {
      for (const line of decoder.push(Buffer.from(chunk)))
        if (open) deliver(line);
    } catch (error) {
      close();
      options.onInvalid(
        error instanceof Diagnostic ? error : frameInvalid(String(error)),
      );
    }
  };
  const end = () => {
    if (!open) return;
    close();
    options.onEnd();
  };
  const send = (message: unknown) => {
    const line = portLine(message);
    if (line !== null) writable.write(line);
  };
  readable.on("data", read);
  readable.on("end", end);
  readable.on("error", end);
  port.on("message", send);
  return close;
}
