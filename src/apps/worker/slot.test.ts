import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import {
  encodeFrame,
  FrameKind,
  instanceFrameSchema,
  type ServerFrame,
} from "./frames.ts";
import { SlotControl } from "./thread-data.ts";

const SHELL = "/bin/sh";
const NO_OUTPUT = "";
const FRAME_DESCRIPTOR_REDIRECT = 'exec 3>&1 1>&2; exec "$0" "$@"';
const SLOT_URL = new URL("./slot.ts", import.meta.url).href;
const MAIN_URL = new URL("../../main.ts", import.meta.url).href;
const SHORT_DEADLINE_MS = 300;
const LONG_DEADLINE_MS = 60000;
const DEADLINE_MARGIN_MS = 5000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MODE_BITS = 0o777;
const SLOT_FAILURE = 1;
const THREAD_STOPPED = 0;
const CLIENT_SECRET = "slot-secret";
const IGNORING_SECRET = "ignore-stop";
const CONSOLE_LINE = "stray console line";
const DIRECT_LINE = "stray direct line";
const PROBE = { call_id: "probe", cancel: true };
const THREAD_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
console.log(${JSON.stringify(CONSOLE_LINE)});
writeSync(1, ${JSON.stringify(`${DIRECT_LINE}\n`)});
workerData.port.postMessage(${JSON.stringify(PROBE)});
parentPort.on("message", (message) => {
  if (message.kind === "stop" && workerData.client_secret !== ${JSON.stringify(IGNORING_SECRET)}) process.exit(0);
});
`;

interface Deadlines {
  initDeadlineMs?: number;
  frameDeadlineMs?: number;
  stopDeadlineMs?: number;
}

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

class SlotProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<Exit>;
  stdout = "";
  stderr = "";
  private readonly waiting: (() => void)[] = [];

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.stdout += chunk.toString();
      for (const wake of this.waiting.splice(0)) wake();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.exited = new Promise((resolve) =>
      child.once("close", (code) =>
        resolve({ code, stdout: this.stdout, stderr: this.stderr }),
      ),
    );
  }

  send(frame: ServerFrame): void {
    this.child.stdin.write(encodeFrame(frame));
  }

  async firstFrame(): Promise<void> {
    while (!this.stdout.includes("\n"))
      await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
}

function spawnSlot(
  t: TestContext,
  args: string[],
  env: NodeJS.ProcessEnv = hostEnvironment(),
): SlotProcess {
  const child = spawn(
    SHELL,
    ["-c", FRAME_DESCRIPTOR_REDIRECT, process.execPath, ...args],
    { env, stdio: "pipe" },
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  return new SlotProcess(child);
}

function slot(
  t: TestContext,
  deadlines: Deadlines,
  env?: NodeJS.ProcessEnv,
): SlotProcess {
  const options = {
    initDeadlineMs: LONG_DEADLINE_MS,
    frameDeadlineMs: LONG_DEADLINE_MS,
    stopDeadlineMs: LONG_DEADLINE_MS,
    ...deadlines,
  };
  const script = `
const { Worker } = await import("node:worker_threads");
const { runSlot } = await import(${JSON.stringify(SLOT_URL)});
await runSlot({
  ...${JSON.stringify(options)},
  start: (data, env) => new Worker(${JSON.stringify(THREAD_SOURCE)}, { eval: true, execArgv: [], workerData: data, transferList: [data.port], env, stdout: true, stderr: true }),
});
`;
  return spawnSlot(t, ["--input-type=module", "-e", script], env);
}

function init(secret = CLIENT_SECRET): ServerFrame {
  return { kind: FrameKind.Init, client_secret: secret };
}

test("serve slot exits 1 with worker.slot.init_absent when no init frame arrives", async (t) => {
  const instance = slot(t, { initDeadlineMs: SHORT_DEADLINE_MS });
  const exit = await instance.exited;
  assert.equal(exit.code, SLOT_FAILURE);
  assert.match(exit.stderr, /worker\.slot\.init_absent/);
  assert.equal(exit.stdout, NO_OUTPUT);
});

test("serve slot exits 1 with worker.slot.channel_closed at the end of stdin", async (t) => {
  const instance = slot(t, {});
  instance.send(init());
  await instance.firstFrame();
  instance.child.stdin.end();
  const exit = await instance.exited;
  assert.equal(exit.code, SLOT_FAILURE);
  assert.match(exit.stderr, /worker\.slot\.channel_closed/);
  assert.match(exit.stderr, /stdin reached its end/);
});

test("serve slot exits 1 with worker.slot.channel_closed when no frame arrives within the frame deadline", async (t) => {
  const instance = slot(t, { frameDeadlineMs: SHORT_DEADLINE_MS });
  const started = performance.now();
  instance.send(init());
  const exit = await instance.exited;
  const elapsed = performance.now() - started;
  assert.equal(exit.code, SLOT_FAILURE);
  assert.match(exit.stderr, /worker\.slot\.channel_closed/);
  assert.match(exit.stderr, /no frame arrived before the deadline/);
  assert.ok(elapsed >= SHORT_DEADLINE_MS, String(elapsed));
  assert.ok(elapsed < SHORT_DEADLINE_MS + DEADLINE_MARGIN_MS, String(elapsed));
});

test("serve slot exits 1 with worker.slot.frame_invalid on an invalid line, a first frame other than init and a second init", async (t) => {
  for (const lines of [
    ["not a frame\n"],
    [encodeFrame({ kind: FrameKind.Ping })],
    [encodeFrame(init()), encodeFrame(init())],
  ]) {
    const instance = slot(t, {});
    for (const line of lines) instance.child.stdin.write(line);
    const exit = await instance.exited;
    assert.equal(exit.code, SLOT_FAILURE, lines.join(""));
    assert.match(exit.stderr, /worker\.slot\.frame_invalid/, lines.join(""));
  }
});

test("a thread write to stdout never reaches the frame descriptor, and serve slot exits with the thread code", async (t) => {
  const root = temporary(t);
  const temporaryDirectory = join(root, "slot", "tmp");
  const instance = slot(
    t,
    {},
    { ...hostEnvironment(), TMPDIR: temporaryDirectory },
  );
  instance.send(init());
  instance.send({ kind: FrameKind.Ping });
  await instance.firstFrame();
  instance.send({ kind: FrameKind.Control, control: SlotControl.Stop });
  const exit = await instance.exited;
  assert.equal(exit.code, THREAD_STOPPED);
  const frames = exit.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => instanceFrameSchema.parse(JSON.parse(line)));
  assert.deepEqual(frames, [{ kind: FrameKind.Port, message: PROBE }]);
  assert.ok(!exit.stdout.includes(CONSOLE_LINE));
  assert.ok(!exit.stdout.includes(DIRECT_LINE));
  assert.ok(exit.stderr.includes(CONSOLE_LINE));
  assert.ok(exit.stderr.includes(DIRECT_LINE));
  assert.equal(
    statSync(temporaryDirectory).mode & MODE_BITS,
    PRIVATE_DIRECTORY_MODE,
  );
});

test("SIGTERM and SIGINT stop the thread through the stop control", async (t) => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const instance = slot(t, {});
    instance.send(init());
    await instance.firstFrame();
    instance.child.kill(signal);
    const exit = await instance.exited;
    assert.equal(exit.code, THREAD_STOPPED, signal);
    assert.equal(exit.stderr.includes("worker.slot."), false, signal);
  }
});

test("a thread that ignores the stop control ends at the stop deadline", async (t) => {
  const instance = slot(t, { stopDeadlineMs: SHORT_DEADLINE_MS });
  instance.send(init(IGNORING_SECRET));
  await instance.firstFrame();
  instance.child.kill("SIGTERM");
  const exit = await instance.exited;
  assert.equal(exit.code, SLOT_FAILURE);
});

test("kanthord serve slot exits 1 with worker.slot.channel_closed at the end of stdin", async (t) => {
  const instance = spawnSlot(t, [
    "--input-type=module",
    "-e",
    `process.argv=[process.execPath,"kanthord","serve","slot"];await import(${JSON.stringify(MAIN_URL)});`,
  ]);
  instance.child.stdin.end();
  const exit = await instance.exited;
  assert.equal(exit.code, SLOT_FAILURE);
  assert.match(exit.stderr, /worker\.slot\.channel_closed/);
  assert.equal(exit.stdout, NO_OUTPUT);
});
