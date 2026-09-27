import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isNumber } from "../../kernel/values.ts";

const EMPTY_ARGUMENT_COUNT = 0;
const COMMAND_TIMEOUT_MS = 10000;
const SUCCESS_EXIT_CODE = 0;

export function kanthord(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  assert.ok(args.length > EMPTY_ARGUMENT_COUNT);
  assert.ok(env.XDG_CONFIG_HOME);
  const entry = new URL("../../main.ts", import.meta.url).href;
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
        ],
        { env, timeout: COMMAND_TIMEOUT_MS },
        (error, stdout, stderr) => {
          const code = error?.code;
          if (error && !isNumber(code)) return reject(error);
          resolve({
            code: isNumber(code) ? code : SUCCESS_EXIT_CODE,
            stdout,
            stderr,
          });
        },
      );
    },
  );
}

export function environment(directory: string): NodeJS.ProcessEnv {
  assert.ok(directory.startsWith("/"));
  assert.ok(existsSync(directory));
  return {
    ...process.env,
    XDG_CONFIG_HOME: directory,
    KANTHORD_CONFIG: join(directory, "absent.yaml"),
    KANTHORD_ENDPOINT: "http://127.0.0.1:1",
    KANTHORD_TOKEN: undefined,
  };
}
