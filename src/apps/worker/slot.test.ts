import assert from "node:assert/strict";
import {
  type ChildProcessWithoutNullStreams,
  spawn,
  spawnSync,
} from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import {
  hostEnvironment,
  stopAfter,
  temporary,
} from "../../kernel/test-support.ts";
import {
  encodeFrame,
  FrameKind,
  instanceFrameSchema,
  type ServerFrame,
} from "./frames.ts";
import { BindingEntryState } from "../../worker/contract.ts";
import { SlotControl } from "./thread-data.ts";
import { bashSandbox } from "../../agent/bash-sandbox.ts";
import { sandboxProbe } from "./slot.ts";

const SHELL = "/bin/sh";
const NO_OUTPUT = "";
const FRAME_DESCRIPTOR_REDIRECT = 'exec 3>&1 1>&2; exec "$0" "$@"';
const SLOT_URL = new URL("./slot.ts", import.meta.url).href;
const MAIN_URL = new URL("../../main.ts", import.meta.url).href;
const BASH_SANDBOX_URL = new URL("../../agent/bash-sandbox.ts", import.meta.url)
  .href;
const ERRORS_URL = new URL("../../kernel/errors.ts", import.meta.url).href;
const DISPOSE_FAILURE = "worker.sandbox.reset_failed";
const SHORT_DEADLINE_MS = 300;
const POLL_MS = 20;
const LONG_DEADLINE_MS = 60000;
const DEADLINE_MARGIN_MS = 5000;
const MAIN_SLOT_TIMEOUT_MS = 120000;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MODE_BITS = 0o777;
const SLOT_FAILURE = 1;
const EXIT_SUCCESS = 0;
const NO_MISSING = 0;
const FIRST_CALL = 1;
const SECOND_CALL = 2;
const PASSING_PROBE = "null";
const SANDBOX_UNAVAILABLE = "worker.slot.sandbox_unavailable";
const WRAP_FAILURE = "wrap rejected for the test";
const DISPOSE_REJECTION = "dispose rejected for the test";
const PROBE_DETAIL = "probe detail from the test";
const SLOW_PROBE_MS = 2000;
const FRAME_DEADLINE_BELOW_PROBE_MS = 600;
const SLOW_PROBE_SOURCE = `async () => {
  process.stderr.write("probe started\\n");
  await new Promise((resolve) => setTimeout(resolve, ${LONG_DEADLINE_MS}));
  return null;
}`;
const STDERR_TAIL_BYTES = 4096;
const THREAD_STOPPED = 0;
const CLIENT_SECRET = "slot-secret";
const IGNORING_SECRET = "ignore-stop";
const CONSOLE_LINE = "stray console line";
const DIRECT_LINE = "stray direct line";
const CLIENT_ID = "client_identity_a";
const SECOND_CLIENT_ID = "client_identity_b";
const PROBE = { call_id: "probe", cancel: true };
const THREAD_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
console.log(${JSON.stringify(CONSOLE_LINE)});
writeSync(1, ${JSON.stringify(`${DIRECT_LINE}\n`)});
const host = (entry) => {
  entry.port.on("message", (message) => entry.port.postMessage({ echo: message }));
  entry.port.postMessage(${JSON.stringify(PROBE)});
};
for (const entry of workerData.entries) host(entry);
parentPort.on("message", (message) => {
  if (message.kind === "bindings")
    for (const entry of message.entries)
      if (entry.port) host(entry);
  if (message.kind === "stop" && workerData.entries[0].client_secret !== ${JSON.stringify(IGNORING_SECRET)}) process.exit(0);
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
  stopAfter(t, () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  });
  return new SlotProcess(child);
}

function slot(
  t: TestContext,
  deadlines: Deadlines,
  env?: NodeJS.ProcessEnv,
  prelude = "",
  probe = `async () => ${PASSING_PROBE}`,
): SlotProcess {
  const options = {
    initDeadlineMs: LONG_DEADLINE_MS,
    frameDeadlineMs: LONG_DEADLINE_MS,
    stopDeadlineMs: LONG_DEADLINE_MS,
    ...deadlines,
  };
  const script = `${prelude}
const { Worker } = await import("node:worker_threads");
const { runSlot } = await import(${JSON.stringify(SLOT_URL)});
await runSlot({
  ...${JSON.stringify(options)},
  probe: ${probe},
  start: (data, env) => new Worker(${JSON.stringify(THREAD_SOURCE)}, { eval: true, execArgv: [], workerData: data, transferList: data.entries.map((entry) => entry.port), env, stdout: true, stderr: true }),
});
`;
  return spawnSlot(t, ["--input-type=module", "-e", script], env);
}

const entryOf = (
  clientId = CLIENT_ID,
  secret = CLIENT_SECRET,
  state: BindingEntryState = BindingEntryState.Serving,
) => ({ client_id: clientId, client_secret: secret, state });

function init(secret = CLIENT_SECRET): ServerFrame {
  return { kind: FrameKind.Init, entries: [entryOf(CLIENT_ID, secret)] };
}

function portFrames(stdout: string) {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => instanceFrameSchema.parse(JSON.parse(line)));
}

async function framesCount(instance: SlotProcess, count: number) {
  while (portFrames(instance.stdout).length < count)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
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
  assert.deepEqual(portFrames(exit.stdout), [
    { kind: FrameKind.Port, client_id: CLIENT_ID, message: PROBE },
  ]);
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

test("serve slot disposes the bash sandbox and exits with the thread code when the dispose rejects", async (t) => {
  const prelude = `
const { bashSandbox } = await import(${JSON.stringify(BASH_SANDBOX_URL)});
const { Diagnostic } = await import(${JSON.stringify(ERRORS_URL)});
bashSandbox.dispose = async () => { throw new Diagnostic(${JSON.stringify(DISPOSE_FAILURE)}, "worker: the bash sandbox reset failed."); };
`;
  const instance = slot(t, {}, undefined, prelude);
  instance.send(init());
  await instance.firstFrame();
  instance.send({ kind: FrameKind.Control, control: SlotControl.Stop });
  const exit = await instance.exited;
  assert.equal(exit.code, THREAD_STOPPED);
  assert.ok(exit.stderr.includes(DISPOSE_FAILURE), exit.stderr);
});

test("a thread that ignores the stop control ends at the stop deadline", async (t) => {
  const instance = slot(t, { stopDeadlineMs: SHORT_DEADLINE_MS });
  instance.send(init(IGNORING_SECRET));
  await instance.firstFrame();
  instance.child.kill("SIGTERM");
  const exit = await instance.exited;
  assert.equal(exit.code, SLOT_FAILURE);
});

test(
  "kanthord serve slot exits 1 with worker.slot.channel_closed at the end of stdin",
  { timeout: MAIN_SLOT_TIMEOUT_MS },
  async (t) => {
    const instance = spawnSlot(
      t,
      [
        "--input-type=module",
        "-e",
        `process.argv=[process.execPath,"kanthord","serve","slot"];await import(${JSON.stringify(MAIN_URL)});`,
      ],
      { ...hostEnvironment(), TMPDIR: temporary(t) },
    );
    instance.child.stdin.end();
    const exit = await instance.exited;
    assert.equal(exit.code, SLOT_FAILURE);
    assert.match(exit.stderr, /worker\.slot\.channel_closed/);
    assert.equal(exit.stdout, NO_OUTPUT);
  },
);

test("serve slot accepts the entry list of the init frame and gives each entry its own port", async (t) => {
  const instance = slot(t, {});
  instance.send({
    kind: FrameKind.Init,
    entries: [entryOf(CLIENT_ID), entryOf(SECOND_CLIENT_ID, "other")],
  });
  await framesCount(instance, 2);
  instance.send({
    kind: FrameKind.Port,
    client_id: SECOND_CLIENT_ID,
    message: { call_id: "to-second" },
  });
  await framesCount(instance, 3);
  instance.send({ kind: FrameKind.Control, control: SlotControl.Stop });
  const exit = await instance.exited;
  assert.equal(exit.code, THREAD_STOPPED);
  const frames = portFrames(exit.stdout);
  assert.deepEqual(frames.map(({ client_id }) => client_id).sort(), [
    CLIENT_ID,
    SECOND_CLIENT_ID,
    SECOND_CLIENT_ID,
  ]);
  assert.deepEqual(frames.find((frame) => "echo" in frame.message)?.message, {
    echo: { call_id: "to-second" },
  });
});

test("serve slot applies a bindings frame and opens a port for the new entry only", async (t) => {
  const instance = slot(t, {});
  instance.send(init());
  await framesCount(instance, 1);
  instance.send({
    kind: FrameKind.Bindings,
    entries: [
      entryOf(CLIENT_ID),
      entryOf(SECOND_CLIENT_ID, "other"),
      entryOf("client_identity_c", "third", BindingEntryState.Draining),
    ],
  });
  await framesCount(instance, 2);
  instance.send({ kind: FrameKind.Control, control: SlotControl.Stop });
  const exit = await instance.exited;
  assert.equal(exit.code, THREAD_STOPPED);
  assert.deepEqual(
    portFrames(exit.stdout).map(({ client_id }) => client_id),
    [CLIENT_ID, SECOND_CLIENT_ID],
  );
});

const REQUIRED_COMMANDS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["rg"],
  linux: ["bwrap", "socat", "rg"],
};

function hostSupportsSandbox(): string | null {
  const required = REQUIRED_COMMANDS[process.platform];
  if (!required) return `the platform ${process.platform} has no sandbox`;
  const missing = required.filter(
    (name) =>
      spawnSync(SHELL, ["-c", `command -v ${name}`]).status !== EXIT_SUCCESS,
  );
  return missing.length === NO_MISSING
    ? null
    : `the host lacks ${missing.join(", ")}`;
}

test("serve slot exits 1 with worker.slot.sandbox_unavailable and the detail, and starts no thread", async (t) => {
  const instance = slot(
    t,
    {},
    undefined,
    "",
    `async () => ${JSON.stringify(PROBE_DETAIL)}`,
  );
  instance.send(init());
  const exit = await instance.exited;
  assert.equal(exit.code, SLOT_FAILURE);
  assert.match(exit.stderr, new RegExp(SANDBOX_UNAVAILABLE));
  assert.ok(exit.stderr.includes(PROBE_DETAIL), exit.stderr);
  assert.ok(!exit.stderr.includes(CONSOLE_LINE));
  assert.equal(exit.stdout, NO_OUTPUT);
});

test("serve slot reads the init frame after a passing probe and counts the init deadline from the probe end", async (t) => {
  const probe = `async () => { await new Promise((resolve) => setTimeout(resolve, ${SLOW_PROBE_MS})); return null; }`;
  const running = slot(
    t,
    { initDeadlineMs: SHORT_DEADLINE_MS },
    undefined,
    "",
    probe,
  );
  running.send(init());
  await running.firstFrame();
  running.send({ kind: FrameKind.Control, control: SlotControl.Stop });
  const stopped = await running.exited;
  assert.equal(stopped.code, THREAD_STOPPED);
  assert.equal(stopped.stderr.includes("worker.slot."), false);

  const absent = slot(
    t,
    { initDeadlineMs: SHORT_DEADLINE_MS },
    undefined,
    "",
    probe,
  );
  const started = performance.now();
  const exit = await absent.exited;
  const elapsed = performance.now() - started;
  assert.equal(exit.code, SLOT_FAILURE);
  assert.match(exit.stderr, /worker\.slot\.init_absent/);
  assert.ok(elapsed >= SLOW_PROBE_MS + SHORT_DEADLINE_MS, String(elapsed));

  const framesAfterProbe = slot(
    t,
    {
      initDeadlineMs: SHORT_DEADLINE_MS,
      frameDeadlineMs: FRAME_DEADLINE_BELOW_PROBE_MS,
    },
    undefined,
    "",
    probe,
  );
  const quiet = await framesAfterProbe.exited;
  assert.equal(quiet.code, SLOT_FAILURE);
  assert.match(quiet.stderr, /worker\.slot\.init_absent/);
  assert.doesNotMatch(quiet.stderr, /worker\.slot\.channel_closed/);
});

test("the default probe answers null on a host that starts the sandbox", async (t) => {
  const unsupported = hostSupportsSandbox();
  if (unsupported) return t.skip(unsupported);
  const detail = await sandboxProbe({
    ...hostEnvironment(),
    TMPDIR: temporary(t),
  });
  assert.equal(detail, null);
});

test("the default probe answers the rejection message of the wrap", async (t) => {
  t.mock.method(bashSandbox, "wrap", async () => {
    throw new Error(WRAP_FAILURE);
  });
  t.mock.method(bashSandbox, "dispose", async () => {});
  assert.equal(await sandboxProbe(hostEnvironment()), WRAP_FAILURE);
});

test("the default probe answers the exit code and the end of standard error of a failed command", async (t) => {
  const noise = "x".repeat(STDERR_TAIL_BYTES);
  t.mock.method(
    bashSandbox,
    "wrap",
    async () => `printf '${noise}' >&2; echo tail-mark >&2; exit 3`,
  );
  t.mock.method(bashSandbox, "dispose", async () => {});
  const detail = await sandboxProbe(hostEnvironment());
  assert.ok(detail !== null);
  assert.ok(detail.startsWith("exit 3: "), detail);
  assert.ok(detail.endsWith("tail-mark"), detail);
  assert.ok(detail.length <= STDERR_TAIL_BYTES + "exit 3: ".length);
});

test("the default probe disposes the sandbox once after the probe, also when the probe fails", async (t) => {
  const dispose = t.mock.method(bashSandbox, "dispose", async () => {});
  const wrap = t.mock.method(bashSandbox, "wrap", async () => "true");
  assert.equal(await sandboxProbe(hostEnvironment()), null);
  assert.equal(dispose.mock.callCount(), FIRST_CALL);
  wrap.mock.mockImplementation(async () => {
    throw new Error(WRAP_FAILURE);
  });
  assert.notEqual(await sandboxProbe(hostEnvironment()), null);
  assert.equal(dispose.mock.callCount(), SECOND_CALL);
});

test("a dispose failure after a passing probe becomes the probe detail", async (t) => {
  t.mock.method(bashSandbox, "wrap", async () => "true");
  t.mock.method(bashSandbox, "dispose", async () => {
    throw new Error(DISPOSE_REJECTION);
  });
  assert.equal(await sandboxProbe(hostEnvironment()), DISPOSE_REJECTION);
});

test("SIGTERM during a slow probe stops the session with the stop code, reads no frame and starts no thread", async (t) => {
  const instance = slot(t, {}, undefined, "", SLOW_PROBE_SOURCE);
  instance.send(init());
  while (!instance.stderr.includes("probe started"))
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  instance.child.kill("SIGTERM");
  const exit = await instance.exited;
  assert.equal(exit.code, THREAD_STOPPED);
  assert.equal(exit.stdout, NO_OUTPUT);
  assert.ok(!exit.stderr.includes(CONSOLE_LINE));
  assert.equal(exit.stderr.includes("worker.slot."), false);
});
