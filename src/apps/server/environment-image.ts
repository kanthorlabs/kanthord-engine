import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { isSea } from "node:sea";
import { z } from "zod";
import { background, type Context } from "../../kernel/context.ts";
import {
  type Environment,
  buildDocument,
  devcontainerPath,
  isLocalFeature,
  lifecycleCommandSchema,
  lifecycleScripts,
  variableRefusal,
} from "../../kernel/devcontainer.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { ensureDirectory } from "../../kernel/files.ts";
import { digest } from "../../kernel/json.ts";
import { killProcessGroup } from "../../kernel/process-group.ts";
import type { SlotEnvironment } from "../../project/contract.ts";
import {
  BASE_SUFFIX,
  ENVIRONMENT_DIRECTORY,
  ENVIRONMENT_IMAGE_PREFIX,
  ImageBuildOutcome,
  PROVED_SUFFIX,
  UNCHECKED_SUFFIX,
  environmentTagOf,
  type EnvironmentFailureClass,
  type EnvironmentRuntime,
  type ImageBuildInput,
  type ImageBuildResult,
} from "../../project/environment-state.ts";
import { ContainerRuntime, type PoolSlot } from "../../worker/contract.ts";
import {
  CONTAINER_UID,
  OWNER_LABEL,
  SLOT_HOME,
  SUCCESS_CODE,
  type RuntimeHost,
} from "./container-runtime.ts";

export const ENVIRONMENT_BUILD_TIMEOUT_MS = 1800000;
export const FAILURE_HOLD_MS = 900000;
export const EnvironmentImageFailure = {
  BuildFailed: "build_failed",
  ImageInvalid: "image_invalid",
} as const;
export type EnvironmentImageFailure =
  (typeof EnvironmentImageFailure)[keyof typeof EnvironmentImageFailure];
export const ENVIRONMENT_IMAGE_FAILED = "worker.pool.environment_image_failed";
const IMAGE_CHECK_TIMEOUT_MS = 120000;
export const IMAGE_COMMAND_TIMEOUT_MS = 60000;
const OUTPUT_TAIL_BYTES = 4096;
const RUN_DIRECTORY_PREFIX = "run-";
const GENERATED_RUN_PREFIX = "slot-";
const GENERATED_RUN_BYTES = 8;
const BUILD_DOCUMENT = "devcontainer.json";
const IMAGE_LIST_FORMAT = "{{.Repository}}:{{.Tag}}";
const UNTAGGED = "<none>";
const LINE_BREAK = /\r?\n/;
const NO_SIGNAL = new AbortController().signal;
const RUNTIME_ORDER = [ContainerRuntime.Podman, ContainerRuntime.Docker];
const CHECK_NAME_PREFIX = "kanthord-env-check-";
const CHECK_NAME_BYTES = 8;
const ABSENT_PROCESS = "ESRCH";
const LAYER_DIRECTORY = "layer";
const WORKSPACE_DIRECTORY = "workspace";
const CURRENT_DIRECTORY = ".";
const CREATE_ONLY = "wx";
const XDG_PREFIX = "XDG_";
const BUILD_VARIABLES = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
  "DOCKER_HOST",
]);
const PATH_OUTSIDE = "the path leaves the checkout";
const PATH_ABSENT = "the path is absent";
const FEATURE_NOT_DIRECTORY = "the feature is not a directory";
const FEATURE_SYMLINK = "the feature holds a symbolic link";
const CONTAINERFILE = "Containerfile";
const METADATA_LABEL = "devcontainer.metadata";
const DEVCONTAINER_CLI = "@devcontainers/cli/package.json";
const DEVCONTAINER_ENTRY = "devcontainer.js";
const KANTHORD_PATH = "/usr/local/bin/kanthord";
const TINI_PATH = "/usr/bin/tini";
const TINI_STATIC_PATH = "/usr/bin/tini-static";
const SHELL = "/bin/sh";
const ENVIRONMENT_ASSIGNMENT = "=";
const NOT_FOUND = -1;
const FAILED_CODE = 1;
const SINGLE_CHUNK = 1;
const VARIABLE_REFERENCE =
  /\$\{(containerEnv|localEnv):([^}:]+)(?::([^}]*))?\}/g;
const CONTAINER_ENV_SCOPE = "containerEnv";
const DOLLAR = /\$/g;
const ESCAPED_DOLLAR = "\\$";

const metadataEntrySchema = z.looseObject({
  containerEnv: z.record(z.string(), z.string()).optional(),
  remoteEnv: z.record(z.string(), z.string().nullable()).optional(),
  onCreateCommand: lifecycleCommandSchema.optional(),
});
const imageInspectSchema = z
  .array(
    z.looseObject({
      Config: z.looseObject({
        Env: z.array(z.string()).nullable().optional(),
        Labels: z.record(z.string(), z.string()).nullable().optional(),
      }),
    }),
  )
  .min(1);

export const PASSWD_SCRIPT = [
  `getent passwd ${CONTAINER_UID} >/dev/null || echo 'kanthord:x:${CONTAINER_UID}:${CONTAINER_UID}::${SLOT_HOME}:/bin/sh' >> /etc/passwd`,
  `getent group ${CONTAINER_UID} >/dev/null || echo 'kanthord:x:${CONTAINER_UID}:' >> /etc/group`,
  `mkdir -p ${SLOT_HOME}`,
  `chown ${CONTAINER_UID}:${CONTAINER_UID} ${SLOT_HOME}`,
].join(" && ");

export const CHECK_SCRIPT = [
  'fail() { echo "$1" >&2; exit 1; }',
  'command -v bash >/dev/null 2>&1 || fail "bash is absent"',
  'getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail "glibc is absent"',
  'command -v git >/dev/null 2>&1 || fail "git is absent"',
  "set -- $(git --version | sed -n 's/^git version \\([0-9]*\\)\\.\\([0-9]*\\).*/\\1 \\2/p')",
  '[ "${1:-0}" -gt 2 ] || { [ "${1:-0}" -eq 2 ] && [ "${2:-0}" -ge 40 ]; } || fail "git 2.40 or later is absent"',
  'command -v ssh >/dev/null 2>&1 || fail "ssh is absent"',
  "set -- $(ssh -V 2>&1 | sed -n 's/^OpenSSH_\\([0-9]*\\)\\.\\([0-9]*\\).*/\\1 \\2/p')",
  '[ "${1:-0}" -ge 9 ] || fail "OpenSSH 9.0 or later is absent"',
  `getent passwd ${CONTAINER_UID} >/dev/null || fail "uid ${CONTAINER_UID} has no passwd entry"`,
  `${TINI_PATH} --version >/dev/null 2>&1 || fail "tini does not run"`,
  `${KANTHORD_PATH} --version >/dev/null 2>&1 || fail "kanthord does not run"`,
].join("\n");

export interface EnvironmentImageOptions {
  readonly host: RuntimeHost;
  readonly owner: string;
  readonly kanthordImage: string;
  readonly version: string;
  readonly stateDirectory: string;
  readonly fallbackImage: string;
  slotEnvironment(
    projectId: string,
    context: Context,
  ): Promise<SlotEnvironment | null>;
  exportRepository(
    bindingId: string,
    commit: string,
    directory: string,
    context: Context,
  ): Promise<void>;
  readonly devcontainerCli?: () => string;
  readonly now?: () => number;
  readonly buildTimeoutMs?: number;
}

interface HeldFailure {
  readonly error: Diagnostic;
  readonly at: number;
  readonly bindingId: string;
}

interface CommandOutput {
  code: number;
  tail: string;
}

export interface LayerInput {
  readonly base: string;
  readonly kanthordImage: string;
  readonly environment: ReadonlyMap<string, string>;
  readonly onCreate: readonly string[];
  readonly owner: string;
}

class BuildFailure extends Error {
  readonly failureClass: EnvironmentImageFailure;
  readonly tail: string;

  constructor(failureClass: EnvironmentImageFailure, tail: string) {
    super(tail);
    this.failureClass = failureClass;
    this.tail = tail;
  }
}

export function environmentDigest(
  environment: SlotEnvironment,
  kanthordImageId: string,
  version: string,
): string {
  return digest({
    resource_identity: environment.resource_identity,
    source: environment.source,
    document: environment.document,
    files: environment.files.map((file) => ({
      path: file.path,
      state: file.state,
      text: file.text,
    })),
    trees: environment.trees.map((tree) => ({
      path: tree.path,
      object: tree.object,
    })),
    kanthord_image: kanthordImageId,
    version,
  });
}

export function devcontainerCliPath(): string {
  if (isSea())
    throw new BuildFailure(
      EnvironmentImageFailure.BuildFailed,
      "The environment build needs the npm install of kanthord.",
    );
  return join(
    dirname(createRequire(import.meta.url).resolve(DEVCONTAINER_CLI)),
    DEVCONTAINER_ENTRY,
  );
}

export function devcontainerBuildArguments(input: {
  cli: string;
  runtime: ContainerRuntime;
  workspace: string;
  config: string;
  image: string;
  owner: string;
}): string[] {
  return [
    input.cli,
    "build",
    "--docker-path",
    input.runtime,
    "--workspace-folder",
    input.workspace,
    "--config",
    input.config,
    "--image-name",
    input.image,
    "--label",
    `${OWNER_LABEL}=${input.owner}`,
  ];
}

export function buildEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined &&
        (BUILD_VARIABLES.has(name) || name.startsWith(XDG_PREFIX)),
    ),
  );
}

function containedPath(
  checkout: string,
  relative: string,
  key: string,
): string {
  let path: string;
  try {
    path = realpathSync(join(checkout, relative));
  } catch {
    throw new BuildFailure(
      EnvironmentImageFailure.BuildFailed,
      `${key}: ${PATH_ABSENT}`,
    );
  }
  if (path !== checkout && !path.startsWith(`${checkout}${sep}`))
    throw new BuildFailure(
      EnvironmentImageFailure.BuildFailed,
      `${key}: ${PATH_OUTSIDE}`,
    );
  return path;
}

function copyFeature(
  checkout: string,
  feature: string,
  directory: string,
): void {
  const key = `features.${feature}`;
  const source = containedPath(checkout, devcontainerPath(feature), key);
  const target = resolvePath(directory, feature);
  if (!target.startsWith(`${resolvePath(directory)}${sep}`))
    throw new BuildFailure(
      EnvironmentImageFailure.BuildFailed,
      `${key}: ${PATH_OUTSIDE}`,
    );
  if (!statSync(source).isDirectory())
    throw new BuildFailure(
      EnvironmentImageFailure.BuildFailed,
      `${key}: ${FEATURE_NOT_DIRECTORY}`,
    );
  const entries = readdirSync(source, { recursive: true, withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink()))
    throw new BuildFailure(
      EnvironmentImageFailure.BuildFailed,
      `${key}: ${FEATURE_SYMLINK}`,
    );
  cpSync(source, target, { recursive: true });
}

export function serverConfig(
  environment: Environment,
  directory: string,
): string {
  const checkout = realpathSync(join(directory, WORKSPACE_DIRECTORY));
  const config = join(directory, BUILD_DOCUMENT);
  const document = buildDocument(environment);
  const build = document.build;
  if (build?.dockerfile !== undefined)
    document.build = {
      ...build,
      dockerfile: containedPath(
        checkout,
        devcontainerPath(build.dockerfile),
        "build.dockerfile",
      ),
      context: containedPath(
        checkout,
        devcontainerPath(build.context ?? CURRENT_DIRECTORY),
        "build.context",
      ),
    };
  for (const feature of Object.keys(document.features ?? {}))
    if (isLocalFeature(feature)) copyFeature(checkout, feature, directory);
  writeFileSync(config, JSON.stringify(document), { flag: CREATE_ONLY });
  return config;
}

function substituted(value: string, current: ReadonlyMap<string, string>) {
  return value.replace(
    VARIABLE_REFERENCE,
    (_match, scope: string, name: string, fallback: string | undefined) =>
      (scope === CONTAINER_ENV_SCOPE ? current.get(name) : undefined) ??
      fallback ??
      "",
  );
}

export function imageSettings(inspected: string): {
  environment: Map<string, string>;
  onCreate: string[];
} {
  const [image] = imageInspectSchema.parse(JSON.parse(inspected));
  const environment = new Map<string, string>();
  for (const entry of image!.Config.Env ?? []) {
    const index = entry.indexOf(ENVIRONMENT_ASSIGNMENT);
    if (index !== NOT_FOUND)
      environment.set(entry.slice(0, index), entry.slice(index + 1));
  }
  const label = image!.Config.Labels?.[METADATA_LABEL];
  const parsed: unknown = label === undefined ? [] : JSON.parse(label);
  const entries = z
    .array(metadataEntrySchema)
    .parse(Array.isArray(parsed) ? parsed : [parsed]);
  const changed = new Map<string, string>();
  const onCreate: string[] = [];
  for (const entry of entries) {
    for (const variables of [entry.containerEnv, entry.remoteEnv])
      for (const [name, value] of Object.entries(variables ?? {})) {
        if (value === null) continue;
        const next = substituted(value, environment);
        environment.set(name, next);
        changed.set(name, next);
      }
    onCreate.push(...lifecycleScripts(entry.onCreateCommand));
  }
  return { environment: changed, onCreate };
}

function shellStep(script: string): string {
  return `RUN ${JSON.stringify([SHELL, "-c", script])}`;
}

export function layerContainerfile(input: LayerInput): string {
  const variables = Array.from(
    input.environment,
    ([name, value]) =>
      `ENV ${name}=${JSON.stringify(value).replace(DOLLAR, ESCAPED_DOLLAR)}`,
  );
  return [
    `FROM ${input.kanthordImage} AS kanthord`,
    `FROM ${input.base}`,
    "USER root",
    ...variables,
    "WORKDIR /",
    ...input.onCreate.map(shellStep),
    `COPY --from=kanthord ${KANTHORD_PATH} ${KANTHORD_PATH}`,
    `COPY --from=kanthord ${TINI_STATIC_PATH} ${TINI_PATH}`,
    shellStep(PASSWD_SCRIPT),
    `LABEL ${OWNER_LABEL}=${JSON.stringify(input.owner)}`,
    `USER ${CONTAINER_UID}`,
    `WORKDIR ${SLOT_HOME}`,
    "",
  ].join("\n");
}

function tailOf(chunks: Buffer[]): string {
  const text = Buffer.concat(chunks).toString("utf8");
  return text.slice(-OUTPUT_TAIL_BYTES);
}

function endGroup(leader: number): void {
  try {
    killProcessGroup(leader);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== ABSENT_PROCESS) throw error;
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  running: Set<number>,
  signal: AbortSignal,
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const chunks: Buffer[] = [];
    let size = 0;
    const keep = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      while (size > OUTPUT_TAIL_BYTES && chunks.length > SINGLE_CHUNK)
        size -= chunks.shift()!.length;
    };
    const child = spawn(command, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const leader = child.pid;
    if (leader !== undefined) running.add(leader);
    const abort = () => {
      if (leader !== undefined) endGroup(leader);
    };
    const timer = setTimeout(() => {
      keep(
        Buffer.from(`\nThe command passed its time limit of ${timeoutMs} ms.`),
      );
      abort();
    }, timeoutMs);
    const finish = (code: number) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (leader !== undefined) running.delete(leader);
      if (signal.aborted) reject(signal.reason);
      else resolve({ code, tail: tailOf(chunks) });
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("error", (error) => {
      keep(Buffer.from(error.message));
      finish(FAILED_CODE);
    });
    child.once("close", (code) => {
      finish(code ?? FAILED_CODE);
    });
  });
}

function imageFailure(
  failure: EnvironmentFailureClass,
  tag: string,
  detail: string,
): Diagnostic {
  return new Diagnostic(
    ENVIRONMENT_IMAGE_FAILED,
    `The environment image ${tag} failed: ${failure}.`,
    {
      fields: [
        ["class", failure],
        ["tag", tag],
        ["detail", detail],
      ],
    },
  );
}

export class EnvironmentImages implements Omit<
  EnvironmentRuntime,
  "proveOnHost" | "prove"
> {
  private readonly options: EnvironmentImageOptions;
  private readonly building = new Map<string, Promise<string>>();
  private readonly failures = new Map<string, HeldFailure>();
  private readonly running = new Set<number>();
  private resolved: ContainerRuntime | null = null;

  constructor(options: EnvironmentImageOptions) {
    this.options = options;
    this.removeRuns();
  }

  get runtimeName(): string {
    return this.runtime();
  }

  stop(): void {
    for (const leader of this.running) endGroup(leader);
  }

  removeStaleRuns(): Promise<void> {
    this.removeRuns();
    return Promise.resolve();
  }

  private runtime(): ContainerRuntime {
    this.resolved ??=
      RUNTIME_ORDER.find((candidate) =>
        this.options.host.resolves(candidate),
      ) ?? null;
    if (this.resolved === null)
      throw new Diagnostic(
        ENVIRONMENT_IMAGE_FAILED,
        "No container runtime is available.",
        { fields: [["class", EnvironmentImageFailure.BuildFailed]] },
      );
    return this.resolved;
  }

  private environmentRoot(): string {
    return join(this.options.stateDirectory, ENVIRONMENT_DIRECTORY);
  }

  private removeRuns(): void {
    const root = this.environmentRoot();
    ensureDirectory(root);
    for (const entry of readdirSync(root))
      if (entry.startsWith(RUN_DIRECTORY_PREFIX))
        rmSync(join(root, entry), { recursive: true, force: true });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private answer(args: readonly string[]) {
    return this.options.host.run(
      this.runtime(),
      args,
      IMAGE_COMMAND_TIMEOUT_MS,
    );
  }

  private heldFailure(tag: string, bindingId: string): Diagnostic | null {
    const held = this.failures.get(tag);
    if (held === undefined) return null;
    if (held.bindingId === bindingId && this.now() - held.at < FAILURE_HOLD_MS)
      return held.error;
    this.failures.delete(tag);
    return null;
  }

  async imageFor(runtime: ContainerRuntime, slot: PoolSlot): Promise<string> {
    this.resolved ??= runtime;
    const environment = await this.options.slotEnvironment(
      slot.project_id,
      background,
    );
    if (environment === null) return this.options.fallbackImage;
    const tag = environmentTagOf(
      environment.resource_identity,
      environmentDigest(
        environment,
        await this.kanthordImageId(),
        this.options.version,
      ),
    );
    const failure = this.heldFailure(tag, environment.binding_id);
    if (failure) throw failure;
    let pending = this.building.get(tag);
    if (!pending) {
      pending = this.ensure(environment, tag).finally(() => {
        this.building.delete(tag);
      });
      this.building.set(tag, pending);
    }
    return pending;
  }

  private async ensure(
    environment: SlotEnvironment,
    tag: string,
  ): Promise<string> {
    if (await this.imageExists(tag)) return tag;
    const result = await this.build(
      {
        run_id: `${GENERATED_RUN_PREFIX}${randomBytes(GENERATED_RUN_BYTES).toString("hex")}`,
        binding_id: environment.binding_id,
        resource_identity: environment.resource_identity,
        commit: environment.commit,
        tag,
        document: environment.document,
      },
      NO_SIGNAL,
    );
    if (result.outcome === ImageBuildOutcome.Built) return tag;
    const error = imageFailure(result.class, tag, result.tail);
    this.failures.set(tag, {
      error,
      at: this.now(),
      bindingId: environment.binding_id,
    });
    throw error;
  }

  private async kanthordImageId(): Promise<string> {
    return (
      (await this.imageId(this.options.kanthordImage, NO_SIGNAL)) ??
      this.options.kanthordImage
    );
  }

  async imageId(
    reference: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    signal.throwIfAborted();
    const inspected = await this.answer([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      reference,
    ]);
    const id = inspected.stdout.trim();
    return inspected.code === SUCCESS_CODE && id ? id : null;
  }

  async pullImage(reference: string, signal: AbortSignal): Promise<void> {
    const pulled = await runCommand(
      this.runtime(),
      ["pull", reference],
      buildEnvironment(this.options.host.environment),
      this.buildTimeoutMs(),
      this.running,
      signal,
    );
    if (pulled.code !== SUCCESS_CODE)
      throw imageFailure(
        EnvironmentImageFailure.BuildFailed,
        reference,
        pulled.tail,
      );
  }

  async imageExists(tag: string): Promise<boolean> {
    const exists = await this.answer(["image", "exists", tag]);
    return exists.code === SUCCESS_CODE;
  }

  async tagProved(tag: string): Promise<void> {
    const proved = `${tag}${PROVED_SUFFIX}`;
    const tagged = await this.answer(["tag", tag, proved]);
    if (tagged.code !== SUCCESS_CODE)
      throw imageFailure(
        EnvironmentImageFailure.BuildFailed,
        proved,
        tagged.stderr.slice(-OUTPUT_TAIL_BYTES),
      );
  }

  async removeTags(tags: readonly string[]): Promise<void> {
    for (const tag of tags) await this.answer(["image", "rm", tag]);
  }

  async collect(
    identityPath: string,
    keepDigest: string | null,
  ): Promise<void> {
    const name = `${ENVIRONMENT_IMAGE_PREFIX}/${identityPath}`;
    const listed = await this.answer([
      "image",
      "ls",
      "--filter",
      `label=${OWNER_LABEL}=${this.options.owner}`,
      "--filter",
      `reference=${name}`,
      "--format",
      IMAGE_LIST_FORMAT,
    ]);
    if (listed.code !== SUCCESS_CODE)
      throw imageFailure(
        EnvironmentImageFailure.BuildFailed,
        name,
        listed.stderr.slice(-OUTPUT_TAIL_BYTES),
      );
    const kept =
      keepDigest === null
        ? []
        : [
            keepDigest,
            `${keepDigest}${BASE_SUFFIX}`,
            `${keepDigest}${PROVED_SUFFIX}`,
          ];
    const prefix = `${name}:`;
    const stale = listed.stdout
      .split(LINE_BREAK)
      .map((line) => line.trim())
      .filter(
        (line) =>
          line.startsWith(prefix) &&
          !line.endsWith(`:${UNTAGGED}`) &&
          !kept.includes(line.slice(prefix.length)),
      );
    await this.removeTags(stale);
  }

  async build(
    input: ImageBuildInput,
    signal: AbortSignal,
  ): Promise<ImageBuildResult> {
    const directory = join(
      this.environmentRoot(),
      `${RUN_DIRECTORY_PREFIX}${input.run_id}`,
    );
    try {
      const base = `${input.tag}${BASE_SUFFIX}`;
      const staging = `${input.tag}${UNCHECKED_SUFFIX}`;
      await this.buildBase(input, directory, base, signal);
      await this.buildLayer(directory, base, staging, signal);
      await this.check(staging, signal);
      await this.promote(input.tag, staging);
      return { outcome: ImageBuildOutcome.Built };
    } catch (error) {
      if (!(error instanceof BuildFailure)) throw error;
      return {
        outcome: ImageBuildOutcome.Failed,
        class: error.failureClass,
        tail: error.tail,
      };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private async buildBase(
    input: ImageBuildInput,
    directory: string,
    base: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const workspace = join(directory, WORKSPACE_DIRECTORY);
    ensureDirectory(workspace);
    await this.options.exportRepository(
      input.binding_id,
      input.commit,
      workspace,
      background,
    );
    const config = serverConfig(input.document, directory);
    const cli = (this.options.devcontainerCli ?? devcontainerCliPath)();
    const built = await runCommand(
      process.execPath,
      devcontainerBuildArguments({
        cli,
        runtime: this.runtime(),
        workspace: directory,
        config,
        image: base,
        owner: this.options.owner,
      }),
      buildEnvironment(this.options.host.environment),
      this.buildTimeoutMs(),
      this.running,
      signal,
    );
    if (built.code !== SUCCESS_CODE)
      throw new BuildFailure(EnvironmentImageFailure.BuildFailed, built.tail);
  }

  private buildTimeoutMs(): number {
    return this.options.buildTimeoutMs ?? ENVIRONMENT_BUILD_TIMEOUT_MS;
  }

  private async buildLayer(
    directory: string,
    base: string,
    staging: string,
    signal: AbortSignal,
  ): Promise<void> {
    const inspected = await this.answer(["image", "inspect", base]);
    if (inspected.code !== SUCCESS_CODE)
      throw new BuildFailure(
        EnvironmentImageFailure.BuildFailed,
        inspected.stderr.slice(-OUTPUT_TAIL_BYTES),
      );
    const settings = imageSettings(inspected.stdout);
    for (const [name, value] of settings.environment) {
      const reason = variableRefusal(name, value);
      if (reason !== null)
        throw new BuildFailure(
          EnvironmentImageFailure.BuildFailed,
          `containerEnv.${name}: ${reason}`,
        );
    }
    const layer = join(directory, LAYER_DIRECTORY);
    ensureDirectory(layer);
    writeFileSync(
      join(layer, CONTAINERFILE),
      layerContainerfile({
        base,
        kanthordImage: this.options.kanthordImage,
        environment: settings.environment,
        onCreate: settings.onCreate,
        owner: this.options.owner,
      }),
    );
    const built = await runCommand(
      this.runtime(),
      [
        "build",
        "--file",
        join(layer, CONTAINERFILE),
        "--tag",
        staging,
        "--label",
        `${OWNER_LABEL}=${this.options.owner}`,
        layer,
      ],
      buildEnvironment(this.options.host.environment),
      this.buildTimeoutMs(),
      this.running,
      signal,
    );
    if (built.code !== SUCCESS_CODE)
      throw new BuildFailure(EnvironmentImageFailure.BuildFailed, built.tail);
  }

  private async check(staging: string, signal: AbortSignal): Promise<void> {
    const name = `${CHECK_NAME_PREFIX}${randomBytes(CHECK_NAME_BYTES).toString("hex")}`;
    const checked = await runCommand(
      this.runtime(),
      [
        "run",
        "--rm",
        "--pull=never",
        "--name",
        name,
        "--label",
        `${OWNER_LABEL}=${this.options.owner}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--network=none",
        "--user",
        String(CONTAINER_UID),
        "--entrypoint",
        SHELL,
        staging,
        "-c",
        CHECK_SCRIPT,
      ],
      buildEnvironment(this.options.host.environment),
      IMAGE_CHECK_TIMEOUT_MS,
      this.running,
      signal,
    ).catch(async (error: unknown) => {
      await this.answer(["rm", "--force", name]);
      await this.removeTags([staging]);
      throw error;
    });
    if (checked.code === SUCCESS_CODE) return;
    await this.answer(["rm", "--force", name]);
    await this.removeTags([staging]);
    throw new BuildFailure(EnvironmentImageFailure.ImageInvalid, checked.tail);
  }

  private async promote(tag: string, staging: string): Promise<void> {
    const tagged = await this.answer(["tag", staging, tag]);
    if (tagged.code !== SUCCESS_CODE)
      throw new BuildFailure(
        EnvironmentImageFailure.BuildFailed,
        tagged.stderr.slice(-OUTPUT_TAIL_BYTES),
      );
    await this.answer(["untag", staging, staging]);
  }
}
