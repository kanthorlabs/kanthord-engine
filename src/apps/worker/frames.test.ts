import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { MessagePort } from "node:worker_threads";
import type { Diagnostic } from "../../kernel/errors.ts";
import {
  bridgePort,
  decodeFrame,
  encodeFrame,
  FRAME_LINE_LIMIT_BYTES,
  FrameDecoder,
  FrameKind,
  instanceFrameSchema,
  type ServerFrame,
  serverFrameSchema,
} from "./frames.ts";
import { BindingEntryState } from "../../worker/contract.ts";
import { SlotControl } from "./thread-data.ts";

const FRAME_INVALID = "worker.slot.frame_invalid";
const INVALID_RESPONSE = "gateway.invocation.invalid_response";
const SERVER_ERROR = 500;
const ANSWERED = 200;
const SPLIT_INSIDE_SEQUENCE = 1;
const CALL_ID = "call";
const CLIENT_ID = "client_identity_a";
const SECOND_CLIENT_ID = "client_identity_b";
const ENTRIES = [
  {
    client_id: CLIENT_ID,
    client_secret: "secret ü 秘密",
    state: BindingEntryState.Serving,
  },
  {
    client_id: "client_identity_b",
    client_secret: "other",
    state: BindingEntryState.Draining,
  },
];
const SERVER_FRAMES: ServerFrame[] = [
  { kind: FrameKind.Init, entries: ENTRIES },
  { kind: FrameKind.Bindings, entries: [] },
  {
    kind: FrameKind.Port,
    client_id: CLIENT_ID,
    message: { call_id: "call", status: ANSWERED, body: { text: "a\nb" } },
  },
  { kind: FrameKind.Control, control: SlotControl.Drain },
  { kind: FrameKind.Control, control: SlotControl.Stop },
  { kind: FrameKind.Ping },
];

class FakePort extends EventEmitter {
  readonly posted: unknown[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
  }
}

function decodeAll(decoder: FrameDecoder, chunks: Buffer[]): ServerFrame[] {
  return chunks.flatMap((chunk) =>
    decoder.push(chunk).map((line) => decodeFrame(line, serverFrameSchema)),
  );
}

function refusal(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as Diagnostic).code;
  }
  return "";
}

function bridge(port: FakePort) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const frames: unknown[] = [];
  const invalid: Diagnostic[] = [];
  const ended: boolean[] = [];
  const attached = bridgePort(readable, writable, {
    frames: instanceFrameSchema,
    onFrame: (frame) => frames.push(frame),
    onInvalid: (error) => invalid.push(error),
    onEnd: () => ended.push(true),
  });
  attached.attach(CLIENT_ID, port as unknown as MessagePort);
  const written = () =>
    String(writable.read() ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { readable, frames, invalid, ended, written, attached };
}

test("each server frame survives an encode and a decode unchanged", () => {
  const decoder = new FrameDecoder();
  const encoded = SERVER_FRAMES.map((frame) => Buffer.from(encodeFrame(frame)));
  assert.deepEqual(decodeAll(decoder, encoded), SERVER_FRAMES);
});

test("a chunk split inside a UTF-8 sequence decodes to the same frame", () => {
  const frame = SERVER_FRAMES[0]!;
  const bytes = Buffer.from(encodeFrame(frame));
  const split = bytes.indexOf(Buffer.from("ü")) + SPLIT_INSIDE_SEQUENCE;
  const decoder = new FrameDecoder();
  assert.deepEqual(
    decodeAll(decoder, [bytes.subarray(0, split), bytes.subarray(split)]),
    [frame],
  );
});

test("two frames in one chunk decode to two frames", () => {
  const decoder = new FrameDecoder();
  const chunk = Buffer.from(
    encodeFrame(SERVER_FRAMES[3]!) + encodeFrame(SERVER_FRAMES[5]!),
  );
  assert.deepEqual(decodeAll(decoder, [chunk]), [
    SERVER_FRAMES[3],
    SERVER_FRAMES[5],
  ]);
});

test("a line above 64 MiB is refused before its end arrives", () => {
  const decoder = new FrameDecoder();
  const line = Buffer.alloc(FRAME_LINE_LIMIT_BYTES + 1, "a");
  assert.equal(
    refusal(() => decoder.push(line)),
    FRAME_INVALID,
  );
});

test("an unknown kind, an unknown key, a non-JSON line and invalid UTF-8 are refused", () => {
  for (const line of [
    '{"kind":"hello"}',
    '{"kind":"ping","extra":true}',
    '{"kind":"init"}',
    '{"kind":"init","client_secret":"secret"}',
    '{"kind":"bindings"}',
    '{"kind":"port","message":{"call_id":"call"}}',
    '{"kind":"port","client_id":"","message":{"call_id":"call"}}',
    '{"kind":"control","control":"pause"}',
    "not json",
  ])
    assert.equal(
      refusal(() => decodeFrame(line, serverFrameSchema)),
      FRAME_INVALID,
      line,
    );
  assert.equal(
    refusal(() =>
      decodeFrame(encodeFrame(SERVER_FRAMES[0]!), instanceFrameSchema),
    ),
    FRAME_INVALID,
  );
  const decoder = new FrameDecoder();
  assert.equal(
    refusal(() => decoder.push(Buffer.from([0xff, 0x0a]))),
    FRAME_INVALID,
  );
});

test("the bridge posts each port frame unchanged and writes each port message as a port frame", () => {
  const port = new FakePort();
  const side = bridge(port);
  const call = { call_id: "call", cancel: true };
  side.readable.write(
    encodeFrame({ kind: FrameKind.Port, client_id: CLIENT_ID, message: call }),
  );
  assert.deepEqual(port.posted, [call]);
  assert.deepEqual(side.frames, [
    { kind: FrameKind.Port, client_id: CLIENT_ID, message: call },
  ]);
  port.emit("message", { call_id: "call", status: ANSWERED, body: null });
  assert.deepEqual(side.written(), [
    {
      kind: FrameKind.Port,
      client_id: CLIENT_ID,
      message: { call_id: "call", status: ANSWERED, body: null },
    },
  ]);
});

test("the bridge writes an answer body as JSON, so a Date becomes text and an undefined field disappears", () => {
  const port = new FakePort();
  const side = bridge(port);
  const at = new Date(0);
  port.emit("message", {
    call_id: "call",
    status: ANSWERED,
    body: { at, gone: undefined },
  });
  assert.deepEqual(side.written(), [
    {
      kind: FrameKind.Port,
      client_id: CLIENT_ID,
      message: {
        call_id: "call",
        status: ANSWERED,
        body: { at: at.toISOString() },
      },
    },
  ]);
});

test("an answer that JSON cannot write becomes a 500 invalid response for its call", () => {
  const port = new FakePort();
  const side = bridge(port);
  port.emit("message", {
    call_id: "call",
    status: ANSWERED,
    body: { count: BigInt(1) },
  });
  const [frame] = side.written() as {
    message: { call_id: string; status: number; body: unknown };
  }[];
  assert.equal(frame?.message.call_id, CALL_ID);
  assert.equal(frame?.message.status, SERVER_ERROR);
  assert.equal(
    (frame?.message.body as { error: { code: string } }).error.code,
    INVALID_RESPONSE,
  );
});

test("an invalid line ends the bridge with frame_invalid, and the end of the input ends it once", () => {
  const port = new FakePort();
  const invalid = bridge(port);
  invalid.readable.write('{"kind":"ping"}\n');
  invalid.readable.write(
    encodeFrame({
      kind: FrameKind.Port,
      client_id: CLIENT_ID,
      message: { call_id: "late" },
    }),
  );
  assert.deepEqual(
    invalid.invalid.map((error) => error.code),
    [FRAME_INVALID],
  );
  assert.deepEqual(port.posted, []);
  const ended = bridge(new FakePort());
  ended.readable.end();
  ended.readable.resume();
  return new Promise<void>((resolve) =>
    setImmediate(() => {
      assert.deepEqual(ended.ended, [true]);
      resolve();
    }),
  );
});

test("the bridge routes a port frame to the port of its client_id and drops the frame of an unknown client", () => {
  const first = new FakePort();
  const second = new FakePort();
  const side = bridge(first);
  side.attached.attach("client_identity_b", second as unknown as MessagePort);
  const call = { call_id: "call", cancel: true };
  side.readable.write(
    encodeFrame({
      kind: FrameKind.Port,
      client_id: "client_identity_b",
      message: call,
    }),
  );
  side.readable.write(
    encodeFrame({
      kind: FrameKind.Port,
      client_id: "client_identity_c",
      message: call,
    }),
  );
  assert.deepEqual(first.posted, []);
  assert.deepEqual(second.posted, [call]);
  second.emit("message", { call_id: "call", status: ANSWERED, body: null });
  assert.equal(
    (side.written() as { client_id: string }[])[0]!.client_id,
    SECOND_CLIENT_ID,
  );
  side.attached.detach(SECOND_CLIENT_ID);
  assert.equal(side.attached.has(SECOND_CLIENT_ID), false);
  second.emit("message", { call_id: "call", status: ANSWERED, body: null });
  assert.deepEqual(side.written(), []);
});
