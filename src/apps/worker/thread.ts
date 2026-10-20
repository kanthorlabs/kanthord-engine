import { isAbsolute } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { Diagnostic } from "../../kernel/errors.ts";
import { directories } from "../../kernel/xdg.ts";
import {
  SlotControl,
  slotControlSchema,
  threadDataSchema,
} from "./thread-data.ts";
import { portTransport } from "./transport.ts";
import { WorkerUnit } from "./unit.ts";

const DIRECTORY_VARIABLES = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
];

async function main(): Promise<void> {
  const data = threadDataSchema.parse(workerData);
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
      bindings: [
        {
          transport: portTransport(data.port),
          client_secret: data.client_secret,
        },
      ],
      directories: { data: state, log: state },
      env: process.env,
      log: data.log,
    });
    parentPort?.on("message", (message: unknown) => {
      const control = slotControlSchema.safeParse(message);
      if (!control.success) return;
      if (control.data.kind === SlotControl.Drain) void unit.drain();
      else void unit.stop();
    });
    const error = await unit.run();
    if (error) throw error;
  } finally {
    data.port.close();
    parentPort?.close();
  }
}

void main();
