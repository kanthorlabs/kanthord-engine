import { workerData } from "node:worker_threads";
import { threadDataSchema } from "./thread-data.ts";
import { portTransport } from "./transport.ts";
import { WorkerUnit } from "./unit.ts";

const data = threadDataSchema.parse(workerData);
const error = await new WorkerUnit({
  transport: portTransport(data.port),
  client_secret: data.client_secret,
  env: process.env,
  log: data.log,
}).run();
if (error) throw error;
