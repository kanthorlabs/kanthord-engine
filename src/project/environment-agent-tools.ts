import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ServiceIdentity } from "../kernel/caller.ts";
import type { Context } from "../kernel/context.ts";
import { parseEnvironmentText } from "../kernel/devcontainer.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Store } from "../kernel/store.ts";
import type {
  ProbeAnswer,
  ProbeCommand,
} from "./environment-probe-contract.ts";
import type { ProjectEnvironments } from "./environment.ts";

const WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const PATH = /^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,254}$/;
const PARENT_SEGMENT = "..";
const WORD_SEPARATOR = " ";
const COMMAND_TEXT_MAX = 256;
const EMPTY_LENGTH = 0;
const PAIR_LENGTH = 2;
const COMMAND_V_LENGTH = 3;
const REQUEST_ID_PREFIX = "env_agent";
const FIXED_PROBES = [
  ["cat", "/etc/os-release"],
  ["uname", "-a"],
  ["dpkg", "-l"],
  ["apk", "info"],
] as const;
const COMMAND_V = ["command", "-v"] as const;
const VERSION_FLAG = "--version";
const LIST = "ls";
const COMMAND_V_SCRIPT = 'command -v "$1"';
const REFUSAL = "Refused: the command is not in the allowlist.";

export const PROBE_ALLOWLIST: readonly string[] = [
  "cat /etc/os-release",
  "uname -a",
  "command -v <word>",
  "<word> --version",
  "ls <path>",
  "dpkg -l",
  "apk info",
];

export type WriteAnswer =
  { written: true } | { written: false; reason: string };

export interface EnvironmentAgentPort {
  probe(command: ProbeCommand, signal: AbortSignal): Promise<ProbeAnswer>;
  write(environment: unknown, signal: AbortSignal): Promise<unknown>;
}

const PROBE_PARAMETERS = Type.Object(
  { command: Type.String({ minLength: 1, maxLength: COMMAND_TEXT_MAX }) },
  { additionalProperties: false },
);
const WRITE_PARAMETERS = Type.Object(
  { environment: Type.Record(Type.String(), Type.Unknown()) },
  { additionalProperties: false },
);

function isWord(text: string | undefined): text is string {
  return text !== undefined && WORD.test(text);
}

function isPath(text: string | undefined): text is string {
  return (
    text !== undefined &&
    PATH.test(text) &&
    !text.split("/").includes(PARENT_SEGMENT)
  );
}

export function parseProbeCommand(text: string): ProbeCommand | null {
  const trimmed = text.trim();
  if (trimmed.length === EMPTY_LENGTH || trimmed.length > COMMAND_TEXT_MAX)
    return null;
  const words = trimmed.split(WORD_SEPARATOR);
  const fixed = FIXED_PROBES.find(
    (form) =>
      form.length === words.length &&
      form.every((word, index) => word === words[index]),
  );
  if (fixed !== undefined) return { argv: [...fixed] };
  const [first, second, third] = words;
  if (
    words.length === COMMAND_V_LENGTH &&
    first === COMMAND_V[0] &&
    second === COMMAND_V[1] &&
    isWord(third)
  )
    return { argv: ["sh", "-c", COMMAND_V_SCRIPT, "sh", third] };
  if (words.length === PAIR_LENGTH && isWord(first) && second === VERSION_FLAG)
    return { argv: [first, VERSION_FLAG] };
  if (words.length === PAIR_LENGTH && first === LIST && isPath(second))
    return { argv: [LIST, second] };
  return null;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: text };
}

export function environmentAgentTools(
  port: EnvironmentAgentPort,
): ToolDefinition[] {
  const probe: ToolDefinition<typeof PROBE_PARAMETERS> = {
    name: "probe",
    label: "Probe the environment image",
    description: `Run one read-only command in a throwaway container of the last image. The command must match the allowlist: ${PROBE_ALLOWLIST.join("; ")}.`,
    parameters: PROBE_PARAMETERS,
    async execute(_id, params, signal) {
      const command = parseProbeCommand(params.command);
      if (command === null)
        return textResult([REFUSAL, ...PROBE_ALLOWLIST].join("\n"));
      const answer = await port.probe(
        command,
        signal ?? new AbortController().signal,
      );
      return textResult(canonicalJSON(answer));
    },
  };
  const write: ToolDefinition<typeof WRITE_PARAMETERS> = {
    name: "environment_write",
    label: "Write the environment",
    description:
      "Store the environment document and build the image. Each call is one attempt. The answer holds the outcome, the class and the tail of the run.",
    parameters: WRITE_PARAMETERS,
    async execute(_id, params, signal) {
      const answer = await port.write(
        params.environment,
        signal ?? new AbortController().signal,
      );
      return textResult(canonicalJSON(answer));
    },
  };
  return [probe, write] as unknown as ToolDefinition[];
}

export async function writeStoredEnvironment(input: {
  environments: ProjectEnvironments;
  store: Store;
  identity: ServiceIdentity;
  project_id: string;
  binding_id: string;
  environment: unknown;
  context: Context;
}): Promise<WriteAnswer> {
  const parsed = parseEnvironmentText(JSON.stringify(input.environment));
  if (parsed.document === null) return { written: false, reason: parsed.error };
  const caller: CallerContext = {
    identity: input.identity,
    context: input.context,
    requestId: createIdentity(REQUEST_ID_PREFIX),
    commit: (write) => input.store.transaction(write),
  };
  try {
    await input.environments.write(
      { project_id: input.project_id, binding_id: input.binding_id },
      parsed.document,
      caller,
    );
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return { written: false, reason: `${error.code}: ${error.message}` };
  }
  return { written: true };
}
