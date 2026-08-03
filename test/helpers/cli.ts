import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

export type CliResult = Readonly<{
  code: number | null;
  stdout: string;
  stderr: string;
}>;

export type RunCliInput = Readonly<{
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
}>;

const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url));

export function runCli(input: RunCliInput): Promise<CliResult> {
  const child = spawn(process.execPath, [entry, ...input.args], {
    cwd: input.cwd ?? tmpdir(),
    env: { ...(input.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutData = "";
  let stderrData = "";

  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutData += chunk.toString("utf8");
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrData += chunk.toString("utf8");
  });

  return new Promise<CliResult>((resolve) => {
    child.on("exit", (code) => {
      resolve({ code, stdout: stdoutData, stderr: stderrData });
    });
  });
}
