import { ulid } from "ulid";
import type {
  EnvironmentProbeRunner,
  ProbeAnswer,
  ProbeCommand,
} from "../../project/index.ts";
import type { ContainerRuntime } from "../../worker/contract.ts";
import {
  CONTAINER_UID,
  OWNER_LABEL,
  type RuntimeHost,
  SUCCESS_CODE,
} from "./container-runtime.ts";
import { IMAGE_COMMAND_TIMEOUT_MS } from "./environment-image.ts";

export const ENVIRONMENT_PROBE_TIMEOUT_MS = 30000;
export const PROBE_OUTPUT_BYTES = 4096;
const PROBE_NAME_PREFIX = "kanthord-probe-";
const PROBE_PIDS_LIMIT = "256";
const WORKSPACE_MOUNT = "/workspace";
const TMP_DIRECTORY = "/tmp";
const CONTINUATION_MASK = 0xc0;
const CONTINUATION_BYTE = 0x80;

function outputTail(stdout: string, stderr: string): string {
  const bytes = Buffer.from(`${stdout}${stderr}`);
  let start = Math.max(0, bytes.length - PROBE_OUTPUT_BYTES);
  while (
    start < bytes.length &&
    (bytes[start]! & CONTINUATION_MASK) === CONTINUATION_BYTE
  )
    start++;
  return bytes.subarray(start).toString("utf8");
}

export class EnvironmentProbe implements EnvironmentProbeRunner {
  private readonly host: RuntimeHost;
  private readonly runtime: ContainerRuntime;
  private readonly owner: string;
  private readonly memoryMb: number;

  constructor(
    host: RuntimeHost,
    runtime: ContainerRuntime,
    owner: string,
    memoryMb: number,
  ) {
    this.host = host;
    this.runtime = runtime;
    this.owner = owner;
    this.memoryMb = memoryMb;
  }

  async run(input: {
    tags: readonly string[];
    checkout: string;
    command: ProbeCommand;
    signal: AbortSignal;
  }): Promise<ProbeAnswer> {
    const image = await this.firstExisting(input.tags, input.signal);
    if (image === null) return { image: null, exit_code: null, output: "" };
    const name = `${PROBE_NAME_PREFIX}${ulid()}`;
    input.signal.throwIfAborted();
    const answer = await this.host.run(
      this.runtime,
      this.arguments(name, image, input.checkout, input.command),
      ENVIRONMENT_PROBE_TIMEOUT_MS,
    );
    if (answer.code !== SUCCESS_CODE)
      await this.host.run(
        this.runtime,
        ["rm", "--force", name],
        IMAGE_COMMAND_TIMEOUT_MS,
      );
    return {
      image,
      exit_code: answer.code,
      output: outputTail(answer.stdout, answer.stderr),
    };
  }

  private async firstExisting(
    tags: readonly string[],
    signal: AbortSignal,
  ): Promise<string | null> {
    for (const tag of tags) {
      signal.throwIfAborted();
      const inspected = await this.host.run(
        this.runtime,
        ["image", "inspect", tag],
        IMAGE_COMMAND_TIMEOUT_MS,
      );
      if (inspected.code === SUCCESS_CODE) return tag;
    }
    return null;
  }

  private arguments(
    name: string,
    image: string,
    checkout: string,
    command: ProbeCommand,
  ): string[] {
    const [entrypoint, ...rest] = command.argv;
    if (entrypoint === undefined)
      throw new Error("The probe command holds no argument.");
    return [
      "run",
      "--rm",
      "--name",
      name,
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit",
      PROBE_PIDS_LIMIT,
      "--user",
      `${CONTAINER_UID}:${CONTAINER_UID}`,
      "--tmpfs",
      TMP_DIRECTORY,
      "--label",
      `${OWNER_LABEL}=${this.owner}`,
      "--memory",
      `${this.memoryMb}m`,
      "--volume",
      `${checkout}:${WORKSPACE_MOUNT}:ro`,
      "--workdir",
      WORKSPACE_MOUNT,
      "--entrypoint",
      entrypoint,
      image,
      ...rest,
    ];
  }
}
