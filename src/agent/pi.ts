import assert from "node:assert/strict";
import { isAbsolute, join } from "node:path";
import { directories } from "../kernel/xdg.ts";

export const PI_DIRECTORY_NAME = "pi";
export const PI_OFFLINE_VALUE = "1";
export type PiCodingAgent = typeof import("@earendil-works/pi-coding-agent");

let directory: string | undefined;
let modulePromise: Promise<PiCodingAgent> | undefined;

export function piDirectory(env: NodeJS.ProcessEnv): string {
  return join(directories(env).state, PI_DIRECTORY_NAME);
}

export function usePiDirectory(path: string): void {
  assert.ok(isAbsolute(path));
  assert.ok(path.endsWith(PI_DIRECTORY_NAME));
  directory ??= path;
}

export function piAgentDirectory(): string {
  directory ??= piDirectory(process.env);
  assert.ok(isAbsolute(directory));
  assert.ok(directory.endsWith(PI_DIRECTORY_NAME));
  return directory;
}

export function loadPi(): Promise<PiCodingAgent> {
  if (modulePromise) return modulePromise;
  process.env.PI_OFFLINE = PI_OFFLINE_VALUE;
  process.env.PI_CODING_AGENT_DIR = piAgentDirectory();
  assert.equal(process.env.PI_OFFLINE, PI_OFFLINE_VALUE);
  assert.equal(process.env.PI_CODING_AGENT_DIR, piAgentDirectory());
  modulePromise = import("@earendil-works/pi-coding-agent");
  return modulePromise;
}
