import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { workerThreadAsset } from "../../kernel/assets.ts";
import { entryPorts, type ThreadData } from "./thread-data.ts";

function threadEntry(): URL {
  return new URL(`./thread${extname(import.meta.url)}`, import.meta.url);
}

export function startThread(data: ThreadData, env: NodeJS.ProcessEnv): Worker {
  const options = {
    workerData: data,
    transferList: entryPorts(data.entries),
    env,
    stdout: true,
    stderr: true,
  };
  const bundle = workerThreadAsset();
  return bundle === undefined
    ? new Worker(fileURLToPath(threadEntry()), options)
    : new Worker(bundle, { ...options, eval: true });
}
