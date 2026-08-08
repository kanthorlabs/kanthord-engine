import { spawn } from "node:child_process";

import { redact } from "./redact.ts";

export type CommandRecord = Readonly<{
  argv: readonly string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  homeDirectory?: string;
}>;

export type CommandInput = Readonly<{
  argv: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
}>;

export type CommandSink = Readonly<{
  print(line: string): void;
  record(entry: CommandRecord): void;
}>;

const safeToken = /^[A-Za-z0-9_./:=@%-]+$/;

export function quoteArgv(argv: readonly string[]): string {
  return argv
    .map((token) => {
      if (safeToken.test(token)) {
        return token;
      }

      return `'${token.replaceAll("'", "'\\''")}'`;
    })
    .join(" ");
}

export async function runCommand(
  sink: CommandSink,
  input: CommandInput,
): Promise<CommandRecord> {
  sink.print(`e2e: $ ${redact(quoteArgv(input.argv))}`);

  const [file, ...args] = input.argv;
  const cwd = input.cwd ?? process.cwd();

  const { exitCode, stdout, stderr } = await new Promise<
    Readonly<{ exitCode: number; stdout: string; stderr: string }>
  >((resolve, reject) => {
    const child = spawn(file as string, args, {
      shell: false,
      cwd,
      env: input.env ?? {},
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 0,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });

    if (input.stdin !== undefined) {
      child.stdin.write(input.stdin);
    }
    child.stdin.end();
  });

  const record: CommandRecord = {
    argv: input.argv,
    cwd,
    exitCode,
    stdout,
    stderr,
  };

  sink.record(record);

  return record;
}
