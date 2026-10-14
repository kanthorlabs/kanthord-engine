import { isAbsolute } from "node:path";
import { workerData } from "node:worker_threads";
import { Diagnostic } from "../../kernel/errors.ts";
import { threadDataSchema } from "./thread-data.ts";
import { portTransport } from "./transport.ts";
import { WorkerUnit } from "./unit.ts";

const DIRECTORY_VARIABLES = [
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
];

const data = threadDataSchema.parse(workerData);
try {
  const refused = DIRECTORY_VARIABLES.filter(
    (name) => !isAbsolute(process.env[name] ?? ""),
  );
  if (refused.length)
    throw new Diagnostic(
      "worker.thread.directory_invalid",
      `worker: ${refused.join(", ")} must be an absolute path.`,
    );
  const error = await new WorkerUnit({
    transport: portTransport(data.port),
    client_secret: data.client_secret,
    env: process.env,
    log: data.log,
  }).run();
  if (error) throw error;
} finally {
  data.port.close();
}
