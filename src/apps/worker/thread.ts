import { isAbsolute } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { Diagnostic } from "../../kernel/errors.ts";
import { directories } from "../../kernel/xdg.ts";
import { SlotBindings } from "./slot-bindings.ts";
import {
  entryPorts,
  threadDataSchema,
  ThreadMessageKind,
  threadMessageSchema,
} from "./thread-data.ts";
import { WorkerUnit } from "./unit.ts";

const DIRECTORY_VARIABLES = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
];

async function main(): Promise<void> {
  const data = threadDataSchema.parse(workerData);
  const bindings = new SlotBindings((line) => process.stderr.write(line));
  try {
    const refused = DIRECTORY_VARIABLES.filter(
      (name) => !isAbsolute(process.env[name] ?? ""),
    );
    if (refused.length)
      throw new Diagnostic(
        "worker.thread.directory_invalid",
        "worker: the directory variables must be absolute paths.",
        { fields: [["variables", refused.join(", ")]] },
      );
    const state = directories(process.env).state;
    const unit = new WorkerUnit({
      bindings: bindings.initial(data.entries),
      directories: { data: state, log: state },
      env: process.env,
      log: data.log,
    });
    bindings.bind(unit);
    parentPort?.on("message", (message: unknown) => {
      const control = threadMessageSchema.safeParse(message);
      if (!control.success) return;
      if (control.data.kind === ThreadMessageKind.Bindings)
        void bindings.apply(control.data.entries);
      else if (control.data.kind === ThreadMessageKind.Drain) void unit.drain();
      else void unit.stop();
    });
    const started = await unit.start();
    if (!started) await bindings.apply(data.entries);
    const error = started ? ((await unit.stop()) ?? started) : await unit.run();
    if (error) throw error;
  } finally {
    for (const port of entryPorts(data.entries)) port.close();
    bindings.close();
    parentPort?.close();
  }
}

void main();
