import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isNumber, isString } from "../../kernel/values.ts";
import { parse, stringify } from "yaml";
import { configuration } from "../../config/index.ts";
import { writePrivate } from "../../kernel/files.ts";

const EMPTY_ARGUMENT_COUNT = 0;
const COMMAND_TIMEOUT_MS = 10000;
const SUCCESS_EXIT_CODE = 0;
const EMPTY_OUTPUT = "";

export function generateMachineToken(input: {
  env: NodeJS.ProcessEnv;
  masterKey: string;
  projectId: string;
  bindingName: string;
  name: string;
}): { token: string; client_secret: string } {
  assert.ok(input.env.XDG_CONFIG_HOME);
  assert.ok(input.projectId && input.bindingName && input.name);
  const path = join(input.env.XDG_CONFIG_HOME, "issuance.yaml");
  writePrivate(
    path,
    stringify(configuration({ master_key: input.masterKey }).getProperties()),
    true,
  );
  const args = [
    "jwt",
    "generate",
    "--project",
    input.projectId,
    "--binding",
    input.bindingName,
    "--name",
    input.name,
    "--config",
    path,
  ];
  const entry = new URL("../../main.ts", import.meta.url).href;
  const generated = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.stdout.isTTY=true;process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
    ],
    { env: input.env, encoding: "utf8", timeout: COMMAND_TIMEOUT_MS },
  );
  if (generated.error) throw generated.error;
  assert.equal(generated.status, SUCCESS_EXIT_CODE);
  assert.equal(generated.stderr, EMPTY_OUTPUT);
  const fragment = parse(generated.stdout) as {
    token: string;
    client_secret: string;
  };
  assert.ok(isString(fragment.token) && fragment.token.length);
  assert.ok(isString(fragment.client_secret) && fragment.client_secret.length);
  return { token: fragment.token, client_secret: fragment.client_secret };
}

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
