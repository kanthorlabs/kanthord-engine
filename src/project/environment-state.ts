import { randomBytes } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EnvironmentSource, type Environment } from "../kernel/devcontainer.ts";
import { digest, timestamp } from "../kernel/json.ts";

export const EnvironmentStatus = {
  None: "none",
  Pending: "pending",
  Building: "building",
  Proving: "proving",
  Ready: "ready",
  Failed: "failed",
} as const;
export type EnvironmentStatus =
  (typeof EnvironmentStatus)[keyof typeof EnvironmentStatus];
export const environmentStatusSchema = z.enum(EnvironmentStatus);

export const EnvironmentTarget = {
  Image: "image",
  Host: "host",
  Remote: "remote",
} as const;
export type EnvironmentTarget =
  (typeof EnvironmentTarget)[keyof typeof EnvironmentTarget];
export const environmentTargetSchema = z.enum(EnvironmentTarget);

export const ProofOutcome = { Passed: "passed", Failed: "failed" } as const;
export type ProofOutcome = (typeof ProofOutcome)[keyof typeof ProofOutcome];
export const proofOutcomeSchema = z.enum(ProofOutcome);

export const FailureOrigin = {
  Onboarding: "onboarding",
  Execution: "execution",
} as const;
export type FailureOrigin = (typeof FailureOrigin)[keyof typeof FailureOrigin];
export const failureOriginSchema = z.enum(FailureOrigin);

export const EnvironmentFailureClass = {
  BuildFailed: "build_failed",
  ImageInvalid: "image_invalid",
  SetupFailed: "setup_failed",
  CommandAbsent: "command_absent",
} as const;
export type EnvironmentFailureClass =
  (typeof EnvironmentFailureClass)[keyof typeof EnvironmentFailureClass];
export const environmentFailureClassSchema = z.enum(EnvironmentFailureClass);

export const ProofPhase = { Setup: "setup", Check: "check" } as const;
export type ProofPhase = (typeof ProofPhase)[keyof typeof ProofPhase];

export const ImageBuildOutcome = { Built: "built", Failed: "failed" } as const;

export const ENVIRONMENT_DIRECTORY = "environments";
export const ENVIRONMENT_IMAGE_PREFIX = "localhost/kanthord-env";
export const BASE_SUFFIX = "-base";
export const PROVED_SUFFIX = "-proved";
export const UNCHECKED_SUFFIX = "-unchecked";
export const TAIL_BYTES = 4096;
export const MAX_CHECKS = 32;

const PATH_MAX_LENGTH = 200;
const PATH_KEPT_LENGTH = 180;
const PATH_HASH_LENGTH = 16;
const COMPONENT_INVALID = /[^a-z0-9]+/g;
const COMPONENT_EDGE = /^-+|-+$/g;
const IDENTITY_SEPARATORS = /[:/]+/;
const PATH_TAIL = /[-/]$/;
const EMPTY_COMPONENT = "x";
const TAG_SEPARATOR = ":";
const PROOF_EXTENSION = ".json";
const TEMPORARY_EXTENSION = ".tmp";
const TEMPORARY_RANDOM_BYTES = 8;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const FILE_NOT_FOUND = "ENOENT";
const DIRECTORY_NOT_EMPTY = "ENOTEMPTY";
const COMMAND_ABSENT_EXIT = 127;
const PASSED_EXIT = 0;
const ROOT_PATH = "";

function component(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(COMPONENT_INVALID, "-")
      .replace(COMPONENT_EDGE, "") || EMPTY_COMPONENT
  );
}

export function environmentPath(resourceIdentity: string): string {
  const path = resourceIdentity
    .split(IDENTITY_SEPARATORS)
    .map(component)
    .join("/");
  if (path.length <= PATH_MAX_LENGTH) return path;
  const hash = digest(resourceIdentity).slice(0, PATH_HASH_LENGTH);
  const kept = path
    .slice(0, PATH_KEPT_LENGTH)
    .replace(PATH_TAIL, EMPTY_COMPONENT);
  return `${kept}-${hash}`;
}

export function environmentTagOf(
  resourceIdentity: string,
  sum: string,
): string {
  return `${ENVIRONMENT_IMAGE_PREFIX}/${environmentPath(resourceIdentity)}${TAG_SEPARATOR}${sum}`;
}

export interface EnvironmentDigestInput {
  resource_identity: string;
  target: EnvironmentTarget;
  source: EnvironmentSource;
  document: Environment | null;
  files: readonly {
    path: string;
    state: string;
    text: string | null;
  }[];
  base_image: string | null;
  slot_image: string | null;
  version: string;
}

export function environmentDigest(input: EnvironmentDigestInput): string {
  return digest({
    resource_identity: input.resource_identity,
    target: input.target,
    source: input.source,
    document: input.document,
    files: input.files.map((file) => ({
      path: file.path,
      state: file.state,
      text: file.text,
    })),
    base_image: input.base_image,
    slot_image: input.slot_image,
    version: input.version,
  });
}

export const checkResultSchema = z.strictObject({
  command: z.string(),
  exit_code: z.int().nullable(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export const proofFileSchema = z.strictObject({
  digest: z.string().min(1),
  outcome: proofOutcomeSchema,
  class: environmentFailureClassSchema.nullable(),
  origin: failureOriginSchema,
  execution_id: z.string().nullable(),
  command: z.string().nullable(),
  exit_code: z.int().nullable(),
  tail: z.string(),
  reproduce: z.string().nullable(),
  checks: z.array(checkResultSchema).max(MAX_CHECKS),
  repairs: z.int().min(0),
  ended_at: timestamp,
});
export type ProofFile = z.infer<typeof proofFileSchema>;

export const environmentFailureSchema = z.strictObject({
  class: environmentFailureClassSchema.nullable(),
  origin: failureOriginSchema,
  execution_id: z.string().nullable(),
  command: z.string().nullable(),
  exit_code: z.int().nullable(),
  tail: z.string(),
  reproduce: z.string().nullable(),
  ended_at: timestamp,
});

export const environmentStateSchema = z.strictObject({
  binding_id: z.string().min(1),
  binding_name: z.string().min(1),
  resource_identity: z.string().min(1),
  target: environmentTargetSchema,
  source: z.enum(EnvironmentSource).nullable(),
  status: environmentStatusSchema,
  digest: z.string().min(1).nullable(),
  tag: z.string().min(1).nullable(),
  run_started_at: timestamp.nullable(),
  step_started_at: timestamp.nullable(),
  reason: z.string().nullable(),
  failure: environmentFailureSchema.nullable(),
  checks: z.array(checkResultSchema).max(MAX_CHECKS),
  repairs: z.int().min(0),
  repairing: z.boolean(),
});
export type EnvironmentState = z.infer<typeof environmentStateSchema>;

export interface CommandResult {
  phase: ProofPhase;
  command: string;
  exit_code: number | null;
  timed_out: boolean;
  output: string;
}

export interface ProofVerdict {
  outcome: ProofOutcome;
  class: EnvironmentFailureClass | null;
  command: string | null;
  exit_code: number | null;
  tail: string;
  checks: CheckResult[];
}

function tailOf(output: string): string {
  return Buffer.from(output, "utf8").subarray(-TAIL_BYTES).toString("utf8");
}

function failedVerdict(
  failureClass: EnvironmentFailureClass,
  result: CommandResult,
): ProofVerdict {
  return {
    outcome: ProofOutcome.Failed,
    class: failureClass,
    command: result.command,
    exit_code: result.exit_code,
    tail: tailOf(result.output),
    checks: [],
  };
}

function setupFailed(result: CommandResult): boolean {
  return (
    result.phase === ProofPhase.Setup &&
    (result.timed_out || result.exit_code !== PASSED_EXIT)
  );
}

function redCheck(result: CommandResult): boolean {
  return (
    result.phase === ProofPhase.Check &&
    (result.timed_out || result.exit_code !== PASSED_EXIT)
  );
}

export function classifyProof(results: readonly CommandResult[]): ProofVerdict {
  const setup = results.find(setupFailed);
  if (setup !== undefined)
    return failedVerdict(EnvironmentFailureClass.SetupFailed, setup);
  const absent = results.find(
    (result) =>
      result.phase === ProofPhase.Check &&
      !result.timed_out &&
      result.exit_code === COMMAND_ABSENT_EXIT,
  );
  if (absent !== undefined)
    return failedVerdict(EnvironmentFailureClass.CommandAbsent, absent);
  return {
    outcome: ProofOutcome.Passed,
    class: null,
    command: null,
    exit_code: null,
    tail: "",
    checks: results.filter(redCheck).map((result) => ({
      command: result.command,
      exit_code: result.timed_out ? null : result.exit_code,
    })),
  };
}

function isAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === FILE_NOT_FOUND;
}

export class ProofFiles {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  read(path: string, sum: string): ProofFile | null {
    let text: string;
    try {
      text = readFileSync(this.fileOf(path, sum), "utf8");
    } catch (error) {
      if (isAbsent(error)) return null;
      throw error;
    }
    const parsed = proofFileSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  }

  write(path: string, file: ProofFile): void {
    const directory = join(this.root, path);
    mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const target = this.fileOf(path, file.digest);
    const temporary = `${target}.${randomBytes(TEMPORARY_RANDOM_BYTES).toString("hex")}${TEMPORARY_EXTENSION}`;
    const descriptor = openSync(temporary, "wx", PRIVATE_FILE_MODE);
    try {
      writeFileSync(descriptor, JSON.stringify(file));
    } catch (error) {
      closeSync(descriptor);
      rmSync(temporary, { force: true });
      throw error;
    }
    closeSync(descriptor);
    try {
      renameSync(temporary, target);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  remove(path: string, sum: string): void {
    rmSync(this.fileOf(path, sum), { force: true });
  }

  digests(path: string): string[] {
    return this.entries(path)
      .filter((name) => name.endsWith(PROOF_EXTENSION))
      .map((name) => name.slice(0, -PROOF_EXTENSION.length));
  }

  paths(): string[] {
    return this.pathsUnder(ROOT_PATH);
  }

  removePath(path: string): void {
    for (const name of this.entries(path))
      if (name.endsWith(PROOF_EXTENSION) || name.endsWith(TEMPORARY_EXTENSION))
        rmSync(join(this.root, path, name), { force: true });
    try {
      rmdirSync(join(this.root, path));
    } catch (error) {
      if (
        !isAbsent(error) &&
        (error as NodeJS.ErrnoException).code !== DIRECTORY_NOT_EMPTY
      )
        throw error;
    }
  }

  private fileOf(path: string, sum: string): string {
    return join(this.root, path, `${sum}${PROOF_EXTENSION}`);
  }

  private entries(path: string): string[] {
    try {
      return readdirSync(join(this.root, path));
    } catch (error) {
      if (isAbsent(error)) return [];
      throw error;
    }
  }

  private pathsUnder(path: string): string[] {
    const found: string[] = [];
    const entries = readdirSync(join(this.root, path), { withFileTypes: true });
    if (
      path !== ROOT_PATH &&
      entries.some((entry) => entry.name.endsWith(PROOF_EXTENSION))
    )
      found.push(path);
    for (const entry of entries)
      if (entry.isDirectory())
        found.push(
          ...this.pathsUnder(
            path === ROOT_PATH ? entry.name : `${path}/${entry.name}`,
          ),
        );
    return found;
  }
}

export interface ImageBuildInput {
  run_id: string;
  binding_id: string;
  resource_identity: string;
  commit: string;
  tag: string;
  document: Environment;
}

export type ImageBuildResult =
  | { outcome: typeof ImageBuildOutcome.Built }
  | {
      outcome: typeof ImageBuildOutcome.Failed;
      class: EnvironmentFailureClass;
      tail: string;
    };

export interface ProofInput {
  run_id: string;
  binding_id: string;
  resource_identity: string;
  commit: string;
  setup: string[];
  checks: string[];
}

export interface EnvironmentRuntime {
  readonly runtimeName: string;
  imageId(reference: string, signal: AbortSignal): Promise<string | null>;
  pullImage(reference: string, signal: AbortSignal): Promise<void>;
  imageExists(tag: string): Promise<boolean>;
  build(input: ImageBuildInput, signal: AbortSignal): Promise<ImageBuildResult>;
  prove(
    input: ProofInput & { tag: string },
    signal: AbortSignal,
  ): Promise<CommandResult[]>;
  proveOnHost(input: ProofInput, signal: AbortSignal): Promise<CommandResult[]>;
  tagProved(tag: string): Promise<void>;
  removeTags(tags: readonly string[]): Promise<void>;
  collect(identityPath: string, keepDigest: string | null): Promise<void>;
  removeStaleRuns(): Promise<void>;
}
