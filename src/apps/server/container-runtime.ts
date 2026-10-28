import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { userInfo } from "node:os";
import { isNumber, isObject, isString } from "../../kernel/values.ts";
import {
  ContainerRuntime,
  PlacementIssue,
  type PlacementStatus,
  PoolPlacement,
} from "../../worker/contract.ts";
import { derivedCrockford } from "./slot-identity.ts";

export const RUNTIME_CHECK_TIMEOUT_MS = 10000;
export const CONTAINER_UID = 10001;
export const SLOT_HOME = "/var/lib/kanthord";
export const OWNER_LABEL = "io.kanthord.owner";
export const CLIENT_ID_LABEL = "io.kanthord.client_id";
export const CACHE_MOUNT = "/var/lib/kanthord/.cache";
export const CACHE_VOLUME_PREFIX = "kanthord_cache_";
export const CACHE_PROJECT_LABEL = "io.kanthord.cache_project";
export const CACHE_RESOURCE_LABEL = "io.kanthord.cache_resource";
export const FORWARDED_VARIABLES = [
  "TZ",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;
export const SERVER_IN_CONTAINER_MARKERS = [
  "/run/.containerenv",
  "/.dockerenv",
] as const;
export const KUBERNETES_VARIABLE = "KUBERNETES_SERVICE_HOST";
const RUNTIME_ORDER = [ContainerRuntime.Podman, ContainerRuntime.Docker];
const OWNER_LABEL_TEXT = "worker/container-owner";
const SLOT_NAME_PREFIX = "kanthord_slot_";
const DETAIL_LIMIT_BYTES = 200;
const CACHE_NAME_HEX_LENGTH = 24;
const MINIMUM_DOCKER_CLIENT_MAJOR = 23;
const ROOT_UID = 0;
const NO_LENGTH = 0;
const FAILED_CODE = 1;
export const SUCCESS_CODE = 0;
const LINUX: NodeJS.Platform = "linux";
const LINE_BREAK = /\r?\n/;
const ROOTLESS_OPTION = "name=rootless";
const DOCKER_DESKTOP = "Docker Desktop";
const NO_SUCH_CONTAINER = /no such container/i;
const VOLUME_EXISTS = /already exists/i;
const NO_SUCH_VOLUME = /no such volume/i;
const SLOT_COMMAND = "exec 3>&1 1>&2; exec /usr/local/bin/kanthord serve slot";
export const TMP_MOUNT = "/tmp:rw,nosuid,nodev,size=64m";
const SLOT_DIRECTORIES = {
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_STATE_HOME: "state",
  XDG_CACHE_HOME: "cache",
};

export interface RuntimeAnswer {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RuntimeHost {
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly user: string;
  readonly environment: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  resolves(runtime: ContainerRuntime): boolean;
  run(
    runtime: ContainerRuntime,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<RuntimeAnswer>;
}

export interface RunCommand {
  readonly image: string;
  readonly clientId: string;
  readonly owner: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cacheVolume: string | null;
}

interface RuntimeAttempt {
  readonly runtime: ContainerRuntime;
  readonly info: Record<string, unknown> | null;
  readonly detail: string;
}

export function slotName(clientId: string): string {
  return `${SLOT_NAME_PREFIX}${clientId}`;
}

export function containerOwner(masterKey: string): string {
  return derivedCrockford(masterKey, OWNER_LABEL_TEXT);
}

export function infoArguments(): string[] {
  return ["info", "--format", "json"];
}

export function ownedArguments(owner: string): string[] {
  return [
    "ps",
    "--all",
    "--filter",
    `label=${OWNER_LABEL}=${owner}`,
    "--format",
    "{{.Names}}",
  ];
}

export function removeArguments(name: string): string[] {
  return ["rm", "--force", name];
}

export function ownedVolumeArguments(owner: string): string[] {
  return [
    "volume",
    "ls",
    "--filter",
    `label=${OWNER_LABEL}=${owner}`,
    "--format",
    "{{.Name}}",
  ];
}

export function removeVolumeArguments(clientId: string): string[] {
  return ["volume", "rm", slotName(clientId)];
}

export function slotClientId(volumeName: string): string | null {
  return volumeName.startsWith(SLOT_NAME_PREFIX)
    ? volumeName.slice(SLOT_NAME_PREFIX.length)
    : null;
}

export function killArguments(name: string): string[] {
  return ["kill", "--signal", "KILL", name];
}

export function volumeArguments(clientId: string, owner: string): string[] {
  return [
    "volume",
    "create",
    "--label",
    `${OWNER_LABEL}=${owner}`,
    "--label",
    `${CLIENT_ID_LABEL}=${clientId}`,
    slotName(clientId),
  ];
}

export function cacheVolumeName(
  owner: string,
  projectId: string,
  resourceIdentity: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([owner, projectId, resourceIdentity]))
    .digest("hex");
  return `${CACHE_VOLUME_PREFIX}${digest.slice(0, CACHE_NAME_HEX_LENGTH)}`;
}

export function cacheVolumeArguments(
  owner: string,
  projectId: string,
  resourceIdentity: string,
): string[] {
  return [
    "volume",
    "create",
    "--label",
    `${OWNER_LABEL}=${owner}`,
    "--label",
    `${CACHE_PROJECT_LABEL}=${projectId}`,
    "--label",
    `${CACHE_RESOURCE_LABEL}=${resourceIdentity}`,
    cacheVolumeName(owner, projectId, resourceIdentity),
  ];
}

export function ownedCacheVolumeArguments(owner: string): string[] {
  return [
    "volume",
    "ls",
    "--filter",
    `label=${OWNER_LABEL}=${owner}`,
    "--filter",
    `label=${CACHE_PROJECT_LABEL}`,
    "--format",
    "{{.Name}}",
  ];
}

export function inspectVolumeArguments(names: readonly string[]): string[] {
  return ["volume", "inspect", ...names];
}

export function removeNamedVolumeArguments(name: string): string[] {
  return ["volume", "rm", name];
}

export interface CacheVolumeListing {
  readonly name: string;
  readonly project_id: string;
  readonly resource_identity: string;
}

export function linesOf(text: string): string[] {
  return text
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter(Boolean);
}

function filled(value: unknown): value is string {
  return isString(value) && value.length > NO_LENGTH;
}

export function parseCacheVolumes(stdout: string): CacheVolumeListing[] {
  const volumes: unknown = JSON.parse(stdout);
  if (!Array.isArray(volumes))
    throw new Error("The volume inspection answers no list.");
  const listings: CacheVolumeListing[] = [];
  for (const volume of volumes) {
    const name = field(volume, "Name");
    const projectId = field(volume, "Labels", CACHE_PROJECT_LABEL);
    const resourceIdentity = field(volume, "Labels", CACHE_RESOURCE_LABEL);
    if (!filled(name) || !filled(projectId) || !filled(resourceIdentity))
      continue;
    listings.push({
      name,
      project_id: projectId,
      resource_identity: resourceIdentity,
    });
  }
  return listings;
}

export function runArguments(command: RunCommand): string[] {
  const name = slotName(command.clientId);
  const directories = Object.entries(SLOT_DIRECTORIES).flatMap(
    ([variable, directory]) => [
      "--env",
      `${variable}=${SLOT_HOME}/${directory}`,
    ],
  );
  const forwarded = FORWARDED_VARIABLES.filter(
    (variable) => command.environment[variable] !== undefined,
  ).flatMap((variable) => ["--env", variable]);
  return [
    "run",
    "--rm",
    "-i",
    "--pull=missing",
    "--name",
    name,
    "--label",
    `${OWNER_LABEL}=${command.owner}`,
    "--label",
    `${CLIENT_ID_LABEL}=${command.clientId}`,
    "--user",
    String(CONTAINER_UID),
    "--sig-proxy=false",
    "--log-driver",
    "none",
    "--no-healthcheck",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--ulimit",
    "core=0",
    "--read-only",
    "--tmpfs",
    TMP_MOUNT,
    "--volume",
    `${name}:${SLOT_HOME}`,
    ...(command.cacheVolume === null
      ? []
      : ["--volume", `${command.cacheVolume}:${CACHE_MOUNT}`]),
    "--workdir",
    SLOT_HOME,
    "--env",
    `HOME=${SLOT_HOME}`,
    "--env",
    `TMPDIR=${SLOT_HOME}/tmp`,
    "--env",
    "LANG=C.UTF-8",
    ...directories,
    ...forwarded,
    "--entrypoint",
    "/usr/bin/tini",
    command.image,
    "--",
    "/bin/sh",
    "-c",
    SLOT_COMMAND,
  ];
}

export function inspectContainerArguments(name: string): string[] {
  return ["container", "inspect", "--format", "{{.Id}}", name];
}

function absentContainer(answer: RuntimeAnswer): boolean {
  return answer.code === SUCCESS_CODE || NO_SUCH_CONTAINER.test(answer.stderr);
}

export async function containerRemovalFailure(
  call: (args: readonly string[]) => Promise<RuntimeAnswer>,
  name: string,
): Promise<RuntimeAnswer | null> {
  const removed = await call(removeArguments(name));
  if (absentContainer(removed)) return null;
  const inspected = await call(inspectContainerArguments(name));
  return inspected.code !== SUCCESS_CODE &&
    NO_SUCH_CONTAINER.test(inspected.stderr)
    ? null
    : removed;
}

export function absentVolume(answer: RuntimeAnswer): boolean {
  return answer.code === SUCCESS_CODE || NO_SUCH_VOLUME.test(answer.stderr);
}

export function presentVolume(answer: RuntimeAnswer): boolean {
  return answer.code === SUCCESS_CODE || VOLUME_EXISTS.test(answer.stderr);
}

export function boundedDetail(text: string): string | null {
  const line = text
    .split(LINE_BREAK)
    .map((part) => part.trim())
    .find(Boolean);
  if (line === undefined) return null;
  let bounded = line.slice(0, DETAIL_LIMIT_BYTES);
  while (Buffer.byteLength(bounded) > DETAIL_LIMIT_BYTES)
    bounded = bounded.slice(0, -1);
  return bounded;
}

function status(
  reason: PlacementIssue | null,
  detail: string | null,
  runtime: ContainerRuntime | null,
): PlacementStatus {
  return {
    placement: PoolPlacement.Container,
    available: reason === null,
    reason,
    detail,
    container_runtime: runtime,
  };
}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

function parseInfo(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return isObject(value) && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function dockerRefusal(info: Record<string, unknown>): string | null {
  const errors = field(info, "ServerErrors");
  if (Array.isArray(errors) && errors.length)
    return isString(errors[0]) ? errors[0] : "docker answers server errors";
  const version = field(info, "ServerVersion");
  if (!isString(version) || !version) return "docker answers no server version";
  const client = field(info, "ClientInfo", "Version");
  const major = isString(client) ? Number.parseInt(client, 10) : Number.NaN;
  if (!Number.isSafeInteger(major) || major < MINIMUM_DOCKER_CLIENT_MAJOR)
    return `docker client ${isString(client) ? client : "unknown"} is below ${MINIMUM_DOCKER_CLIENT_MAJOR}`;
  return null;
}

function podmanRefusal(info: Record<string, unknown>): string | null {
  return isObject(field(info, "host")) ? null : "podman answers no host";
}

async function attempt(
  host: RuntimeHost,
  runtime: ContainerRuntime,
): Promise<RuntimeAttempt> {
  const answer = await host.run(
    runtime,
    infoArguments(),
    RUNTIME_CHECK_TIMEOUT_MS,
  );
  const failure =
    boundedDetail(answer.stderr) ?? `${runtime} info exits ${answer.code}`;
  const info = parseInfo(answer.stdout);
  if (!info) return { runtime, info: null, detail: failure };
  const refusal =
    runtime === ContainerRuntime.Docker
      ? dockerRefusal(info)
      : podmanRefusal(info);
  if (refusal !== null)
    return { runtime, info: null, detail: boundedDetail(refusal) ?? failure };
  return answer.code === SUCCESS_CODE
    ? { runtime, info, detail: "" }
    : { runtime, info: null, detail: failure };
}

function coversContainerUid(info: Record<string, unknown>): boolean {
  const map = field(info, "host", "idMappings", "uidmap");
  if (!Array.isArray(map)) return false;
  return map.some((entry) => {
    const start = field(entry, "container_id");
    const size = field(entry, "size");
    return (
      isNumber(start) &&
      isNumber(size) &&
      start <= CONTAINER_UID &&
      CONTAINER_UID < start + size
    );
  });
}

function rootful(runtime: ContainerRuntime, info: Record<string, unknown>) {
  if (runtime === ContainerRuntime.Podman)
    return field(info, "host", "security", "rootless") === false;
  if (field(info, "OperatingSystem") === DOCKER_DESKTOP) return false;
  const options = field(info, "SecurityOptions");
  return !(
    Array.isArray(options) &&
    options.some(
      (option) => isString(option) && option.includes(ROOTLESS_OPTION),
    )
  );
}

function answered(
  host: RuntimeHost,
  runtime: ContainerRuntime,
  info: Record<string, unknown>,
): PlacementStatus {
  if (
    runtime === ContainerRuntime.Podman &&
    field(info, "host", "security", "rootless") === true &&
    !coversContainerUid(info)
  )
    return status(
      PlacementIssue.RuntimeFailed,
      boundedDetail(
        `the subordinate uid range of ${host.user} does not cover the container uid ${CONTAINER_UID}`,
      ),
      runtime,
    );
  if (
    host.platform === LINUX &&
    host.uid !== ROOT_UID &&
    rootful(runtime, info)
  )
    return status(PlacementIssue.RuntimeRootful, null, runtime);
  return status(null, null, runtime);
}

export async function detectRuntime(
  host: RuntimeHost,
): Promise<PlacementStatus> {
  if (
    SERVER_IN_CONTAINER_MARKERS.some((path) => host.exists(path)) ||
    host.environment[KUBERNETES_VARIABLE] !== undefined
  )
    return status(PlacementIssue.ServerInContainer, null, null);
  const runtimes = RUNTIME_ORDER.filter((runtime) => host.resolves(runtime));
  if (!runtimes.length) return status(PlacementIssue.RuntimeAbsent, null, null);
  let firstFailure: string | null = null;
  for (const runtime of runtimes) {
    const result = await attempt(host, runtime);
    if (result.info) return answered(host, runtime, result.info);
    firstFailure ??= result.detail;
  }
  return status(PlacementIssue.RuntimeFailed, firstFailure, null);
}

function onPath(command: string, environment: NodeJS.ProcessEnv): boolean {
  const entries = (environment.PATH ?? "").split(delimiter).filter(Boolean);
  return entries.some((directory) => {
    try {
      accessSync(join(directory, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function exitCode(error: unknown): number {
  const code: unknown = isObject(error) ? Reflect.get(error, "code") : null;
  return isNumber(code) ? code : FAILED_CODE;
}

export function runtimeCommand(
  environment: NodeJS.ProcessEnv,
): RuntimeHost["run"] {
  return (runtime, args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(
        runtime,
        args,
        { env: environment, timeout: timeoutMs, encoding: "utf8" },
        (error, stdout, stderr) => {
          resolve({
            code: error ? exitCode(error) : SUCCESS_CODE,
            stdout,
            stderr,
          });
        },
      );
    });
}

export function systemRuntimeHost(environment: NodeJS.ProcessEnv): RuntimeHost {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? ROOT_UID,
    user: userInfo().username,
    environment,
    exists: (path) => existsSync(path),
    resolves: (runtime) => onPath(runtime, environment),
    run: runtimeCommand(environment),
  };
}
