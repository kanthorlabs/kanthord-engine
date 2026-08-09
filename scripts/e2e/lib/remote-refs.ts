import { RunnerError } from "./errors.ts";
import type { CommandRecord } from "./command.ts";

export type RemoteRefsInput = Readonly<{
  origin: string;
  username: string;
  tokenPath: string;
}>;

export type ReadRemoteRefs = (
  input: RemoteRefsInput,
) => Promise<Readonly<Record<string, string>>>;

function rightHelper(username: string, tokenPath: string): string {
  return `!f() { echo username=${username}; echo "password=$(cat ${tokenPath})"; }; f`;
}

export function remoteRefsScript(input: RemoteRefsInput): string {
  return `GIT_TERMINAL_PROMPT=0 git -c 'credential.helper=${rightHelper(input.username, input.tokenPath)}' ls-remote '${input.origin}'`;
}

export function parseRemoteRefs(
  stdout: string,
): Readonly<Record<string, string>> {
  const refs = new Map<string, string>();

  for (const line of stdout.split("\n")) {
    const match = /^([0-9a-f]{40,64})\t(.+)$/.exec(line);
    if (match === null) {
      continue;
    }

    const oid = match[1];
    const ref = match[2];
    if (oid === undefined || ref === undefined) {
      continue;
    }
    refs.set(ref, oid);
  }

  const entries = [...refs.entries()].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  return Object.fromEntries(entries);
}

export async function runRemoteRefs(
  runShell: (script: string) => Promise<CommandRecord>,
  input: RemoteRefsInput,
): Promise<Readonly<Record<string, string>>> {
  const record = await runShell(remoteRefsScript(input));
  if (record.exitCode !== 0) {
    throw new RunnerError(
      "unavailable",
      `git ls-remote against ${input.origin} exited ${record.exitCode}`,
    );
  }
  return parseRemoteRefs(record.stdout);
}
