import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isSea } from "node:sea";
import { z } from "zod";
import { background, type Context } from "../../kernel/context.ts";
import {
  DEVCONTAINER_DIRECTORY,
  DEVCONTAINER_FILE,
  EnvironmentSource,
  lifecycleCommandSchema,
  lifecycleScripts,
} from "../../kernel/devcontainer.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { ensureDirectory } from "../../kernel/files.ts";
import { digest } from "../../kernel/json.ts";
import type { SlotEnvironment } from "../../project/contract.ts";
import type { ContainerRuntime, PoolSlot } from "../../worker/contract.ts";
import {
  CONTAINER_UID,
  OWNER_LABEL,
  SLOT_HOME,
  SUCCESS_CODE,
  type RuntimeHost,
} from "./container-runtime.ts";

export const ENVIRONMENT_IMAGE_PREFIX = "localhost/kanthord-env";
export const ENVIRONMENT_BUILD_TIMEOUT_MS = 1800000;
export const STORED_CONFIG_FILE = `${DEVCONTAINER_DIRECTORY}/kanthord.devcontainer.json`;
export const BASE_TAG_SUFFIX = "-base";
export const EnvironmentImageFailure = {
  BuildFailed: "build_failed",
  ImageInvalid: "image_invalid",
} as const;
export type EnvironmentImageFailure =
  (typeof EnvironmentImageFailure)[keyof typeof EnvironmentImageFailure];
export const ENVIRONMENT_IMAGE_FAILED = "worker.pool.environment_image_failed";
const IMAGE_CHECK_TIMEOUT_MS = 120000;
const IMAGE_COMMAND_TIMEOUT_MS = 60000;
const OUTPUT_TAIL_BYTES = 4096;
const BUILD_DIRECTORY = "environments";
const LAYER_DIRECTORY = "layer";
const WORKSPACE_DIRECTORY = "workspace";
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
const COMPONENT_INVALID = /[^a-z0-9]+/g;
const COMPONENT_EDGE = /^-+|-+$/g;
const IDENTITY_SEPARATORS = /[:/]+/;
const EMPTY_COMPONENT = "x";
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

function component(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(COMPONENT_INVALID, "-")
      .replace(COMPONENT_EDGE, "") || EMPTY_COMPONENT
  );
}

export function environmentTag(resourceIdentity: string, sum: string): string {
  const path = resourceIdentity
    .split(IDENTITY_SEPARATORS)
    .map(component)
    .join("/");
  return `${ENVIRONMENT_IMAGE_PREFIX}/${path}:${sum}`;
}

export function environmentDigest(
  environment: SlotEnvironment,
  kanthordImage: string,
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
    kanthord_image: kanthordImage,
    version,
  });
}

export function devcontainerCliPath(): string {
  if (isSea())
    throw new Diagnostic(
      ENVIRONMENT_IMAGE_FAILED,
      "The environment build needs the npm install of kanthord.",
      { fields: [["class", EnvironmentImageFailure.BuildFailed]] },
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
    `COPY --from=kanthord ${KANTHORD_PATH} ${KANTHORD_PATH}`,
    `COPY --from=kanthord ${TINI_STATIC_PATH} ${TINI_PATH}`,
    shellStep(PASSWD_SCRIPT),
    ...variables,
    "WORKDIR /",
    ...input.onCreate.map(shellStep),
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

function runCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<CommandOutput> {
  return new Promise((resolve) => {
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
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("error", (error) => {
      keep(Buffer.from(error.message));
      resolve({ code: FAILED_CODE, tail: tailOf(chunks) });
    });
    child.once("close", (code) => {
      resolve({ code: code ?? FAILED_CODE, tail: tailOf(chunks) });
    });
  });
}

function imageFailure(
  failure: EnvironmentImageFailure,
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

export class EnvironmentImages {
  private readonly options: EnvironmentImageOptions;
  private readonly building = new Map<string, Promise<string>>();
  private readonly failures = new Map<string, Diagnostic>();

  constructor(options: EnvironmentImageOptions) {
    this.options = options;
  }

  async imageFor(runtime: ContainerRuntime, slot: PoolSlot): Promise<string> {
    const environment = await this.options.slotEnvironment(
      slot.project_id,
      background,
    );
    if (environment === null) return this.options.fallbackImage;
    const tag = environmentTag(
      environment.resource_identity,
      environmentDigest(
        environment,
        this.options.kanthordImage,
        this.options.version,
      ),
    );
    const failure = this.failures.get(tag);
    if (failure) throw failure;
    const exists = await this.options.host.run(
      runtime,
      ["image", "exists", tag],
      IMAGE_COMMAND_TIMEOUT_MS,
    );
    if (exists.code === SUCCESS_CODE) return tag;
    let pending = this.building.get(tag);
    if (!pending) {
      pending = this.build(runtime, environment, tag).finally(() => {
        this.building.delete(tag);
      });
      this.building.set(tag, pending);
    }
    return pending;
  }

  private async build(
    runtime: ContainerRuntime,
    environment: SlotEnvironment,
    tag: string,
  ): Promise<string> {
    const root = join(this.options.stateDirectory, BUILD_DIRECTORY);
    ensureDirectory(root);
    const directory = mkdtempSync(join(root, "build-"));
    try {
      const base = `${tag}${BASE_TAG_SUFFIX}`;
      await this.buildBase(runtime, environment, directory, tag, base);
      await this.buildLayer(runtime, directory, tag, base);
      await this.check(runtime, tag);
      return tag;
    } catch (error) {
      if (
        error instanceof Diagnostic &&
        error.code === ENVIRONMENT_IMAGE_FAILED
      )
        this.failures.set(tag, error);
      throw error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private async buildBase(
    runtime: ContainerRuntime,
    environment: SlotEnvironment,
    directory: string,
    tag: string,
    base: string,
  ): Promise<void> {
    const workspace = join(directory, WORKSPACE_DIRECTORY);
    await this.options.exportRepository(
      environment.binding_id,
      environment.commit,
      workspace,
      background,
    );
    let config = join(workspace, DEVCONTAINER_FILE);
    if (environment.source === EnvironmentSource.Stored) {
      config = join(workspace, STORED_CONFIG_FILE);
      mkdirSync(dirname(config), { recursive: true });
      writeFileSync(config, JSON.stringify(environment.document));
    }
    const cli = (this.options.devcontainerCli ?? devcontainerCliPath)();
    const built = await runCommand(
      process.execPath,
      devcontainerBuildArguments({
        cli,
        runtime,
        workspace,
        config,
        image: base,
        owner: this.options.owner,
      }),
      this.options.host.environment,
      ENVIRONMENT_BUILD_TIMEOUT_MS,
    );
    if (built.code !== SUCCESS_CODE)
      throw imageFailure(EnvironmentImageFailure.BuildFailed, tag, built.tail);
  }

  private async buildLayer(
    runtime: ContainerRuntime,
    directory: string,
    tag: string,
    base: string,
  ): Promise<void> {
    const inspected = await this.options.host.run(
      runtime,
      ["image", "inspect", base],
      IMAGE_COMMAND_TIMEOUT_MS,
    );
    if (inspected.code !== SUCCESS_CODE)
      throw imageFailure(
        EnvironmentImageFailure.BuildFailed,
        tag,
        inspected.stderr.slice(-OUTPUT_TAIL_BYTES),
      );
    const settings = imageSettings(inspected.stdout);
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
      runtime,
      [
        "build",
        "--file",
        join(layer, CONTAINERFILE),
        "--tag",
        tag,
        "--label",
        `${OWNER_LABEL}=${this.options.owner}`,
        layer,
      ],
      this.options.host.environment,
      ENVIRONMENT_BUILD_TIMEOUT_MS,
    );
    if (built.code !== SUCCESS_CODE)
      throw imageFailure(EnvironmentImageFailure.BuildFailed, tag, built.tail);
  }

  private async check(runtime: ContainerRuntime, tag: string): Promise<void> {
    const checked = await runCommand(
      runtime,
      [
        "run",
        "--rm",
        "--pull=never",
        "--user",
        String(CONTAINER_UID),
        "--entrypoint",
        SHELL,
        tag,
        "-c",
        CHECK_SCRIPT,
      ],
      this.options.host.environment,
      IMAGE_CHECK_TIMEOUT_MS,
    );
    if (checked.code === SUCCESS_CODE) return;
    await this.options.host.run(
      runtime,
      ["image", "rm", tag],
      IMAGE_COMMAND_TIMEOUT_MS,
    );
    throw imageFailure(EnvironmentImageFailure.ImageInvalid, tag, checked.tail);
  }
}
