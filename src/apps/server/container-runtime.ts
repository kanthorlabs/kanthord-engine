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
  type RuntimeImageUsage,
  type RuntimeStoreInfo,
  type RuntimeUsage,
  type RuntimeVolumeUsage,
} from "../../worker/contract.ts";
import { derivedCrockford } from "./slot-identity.ts";

export const RUNTIME_CHECK_TIMEOUT_MS = 10000;
export const CONTAINER_UID = 10001;
export const SLOT_HOME = "/var/lib/kanthord";
export const OWNER_LABEL = "io.kanthord.owner";
export const INSTANCE_LABEL = "io.kanthord.instance";
export const CACHE_MOUNT = "/var/lib/kanthord/.cache";
export const CACHE_VOLUME_PREFIX = "kanthord_cache_";
export const CACHE_PROJECT_LABEL = "io.kanthord.cache_project";
export const CACHE_RESOURCE_LABEL = "io.kanthord.cache_resource";
export const CONTAINER_SESSIONS_DIRECTORY = "sessions";
export const SESSION_MOUNT = "/var/lib/kanthord/state/kanthord/pi/sessions";
export const PODMAN_MIN_VERSION = "6.0.0";
const ID_MAP_KEY = "io.kanthord.id_map";
const ID_MAP_VALUE = "auto";
export const ID_MAP_LABEL = `${ID_MAP_KEY}=${ID_MAP_VALUE}`;
export const CACHE_OWNER_MARKER = ".kanthord_owner";
export const MIGRATE_NAME_PREFIX = "kanthord_migrate_";
export const AUTO_USER_NAMESPACE = `--userns=auto:uidmapping=${CONTAINER_UID}:0:1,gidmapping=${CONTAINER_UID}:0:1`;
export const KEEP_ID_USER_NAMESPACE = `--userns=keep-id:uid=${CONTAINER_UID},gid=${CONTAINER_UID}`;
export const NO_TIME_LIMIT_MS = 0;
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
const NO_BYTES = 0;
const NO_COUNT = 0;
const NO_EPOCH = 0;
const BINARY_UNIT = 1024;
const MEBI = 2;
const GIBI = 3;
const TEBI = 4;
const PEBI = 5;
const FAILED_CODE = 1;
export const SUCCESS_CODE = 0;
const LINUX: NodeJS.Platform = "linux";
const MACOS: NodeJS.Platform = "darwin";
const SELINUX_OPTION = "name=selinux";
const PRIVATE_LABEL = ":Z";
const VERSION_SEPARATOR = ".";
const MIGRATE_MOUNT = "/migrate";
const SHELL = "/bin/sh";
const SESSION_SOURCE = `${SLOT_HOME}/state/kanthord/pi/sessions`;
const HOST_DIRECTORY_SCRIPT = `src=${SESSION_SOURCE}; if [ -d "$src" ]; then cp -a "$src/." ${MIGRATE_MOUNT}/ && rm -rf "$src"; fi; mkdir -p "$src" && chown -R ${CONTAINER_UID}:${CONTAINER_UID} ${SLOT_HOME} ${MIGRATE_MOUNT}`;
const FILE_SHARE_SCRIPT = `src=${SESSION_SOURCE}; if [ -d "$src" ]; then cp -R --preserve=mode,timestamps "$src/." ${MIGRATE_MOUNT}/ && rm -rf "$src"; fi; mkdir -p "$src" && chown -R ${CONTAINER_UID}:${CONTAINER_UID} ${SLOT_HOME}`;
export const UNSHARE_MIGRATION_SCRIPT = `src="$1/state/kanthord/pi/sessions"; if [ -d "$src" ]; then cp -a "$src/." "$2/" && rm -rf "$src"; fi; mkdir -p "$src" && chown -R 0:0 "$1" "$2"`;
const CACHE_MARKER_PATH = `${CACHE_MOUNT}/${CACHE_OWNER_MARKER}`;
const CACHE_OWNER_SCRIPT = `[ -e ${CACHE_MARKER_PATH} ] || { chown -R ${CONTAINER_UID}:${CONTAINER_UID} ${CACHE_MOUNT} && touch ${CACHE_MARKER_PATH} && chown ${CONTAINER_UID}:${CONTAINER_UID} ${CACHE_MARKER_PATH}; }`;
const CARRIER_CAPABILITIES = [
  "--cap-drop=ALL",
  "--cap-add=CHOWN",
  "--cap-add=DAC_OVERRIDE",
  "--cap-add=FOWNER",
];
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
    signal?: AbortSignal,
  ): Promise<RuntimeAnswer>;
}

export interface RuntimeFacts {
  readonly rootless: boolean;
  readonly selinux: boolean;
  readonly platform: NodeJS.Platform;
  readonly dockerDesktop: boolean;
  readonly remote: boolean;
}

export interface RuntimeCheck {
  readonly status: PlacementStatus;
  readonly facts: RuntimeFacts | null;
}

export const IdMap = {
  None: "none",
  Auto: "auto",
  KeepId: "keep_id",
  Unshare: "unshare",
} as const;
export type IdMap = (typeof IdMap)[keyof typeof IdMap];

export interface RunCommand {
  readonly image: string;
  readonly instanceName: string;
  readonly owner: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cacheVolume: string | null;
  readonly sessionDirectory: string;
  readonly rootless: boolean;
  readonly selinux: boolean;
}

export interface MigrationCommand {
  readonly image: string;
  readonly instanceName: string;
  readonly owner: string;
  readonly mount: string;
  readonly idMap: typeof IdMap.None | typeof IdMap.Auto | typeof IdMap.KeepId;
  readonly facts: RuntimeFacts;
}

export interface CacheOwnerCommand {
  readonly image: string;
  readonly owner: string;
  readonly volume: string;
  readonly idMap: typeof IdMap.Auto | typeof IdMap.KeepId;
}

export interface VolumeState {
  readonly createdAt: string;
  readonly labeled: boolean;
  readonly mountPoint: string;
}

interface RuntimeAttempt {
  readonly runtime: ContainerRuntime;
  readonly info: Record<string, unknown> | null;
  readonly detail: string;
}

export function slotName(instanceName: string): string {
  return `${SLOT_NAME_PREFIX}${instanceName}`;
}

export function migrateName(instanceName: string): string {
  return `${MIGRATE_NAME_PREFIX}${instanceName}`;
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

export function removeVolumeArguments(instanceName: string): string[] {
  return ["volume", "rm", slotName(instanceName)];
}

export function slotInstanceName(volumeName: string): string | null {
  return volumeName.startsWith(SLOT_NAME_PREFIX)
    ? volumeName.slice(SLOT_NAME_PREFIX.length)
    : null;
}

export function killArguments(name: string): string[] {
  return ["kill", "--signal", "KILL", name];
}

export function volumeArguments(instanceName: string, owner: string): string[] {
  return [
    "volume",
    "create",
    "--label",
    `${OWNER_LABEL}=${owner}`,
    "--label",
    `${INSTANCE_LABEL}=${instanceName}`,
    "--label",
    ID_MAP_LABEL,
    slotName(instanceName),
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
    "--label",
    ID_MAP_LABEL,
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
  readonly created_at: number | null;
}

const SIZE_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*([kKMGTP]?i?B)?\s*$/;
const SIZE_UNITS: Readonly<Record<string, number>> = {
  B: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  PB: 1e15,
  KiB: BINARY_UNIT,
  MiB: BINARY_UNIT ** MEBI,
  GiB: BINARY_UNIT ** GIBI,
  TiB: BINARY_UNIT ** TEBI,
  PiB: BINARY_UNIT ** PEBI,
};
const NO_REFERENCE = "<none>";
const IMAGE_ID_PREFIX = "sha256:";
const IMAGE_ID_HEX = /^[0-9a-f]+$/;
const SECONDS_LIMIT = 1e11;
const MS_PER_SECOND = 1000;
const DOCKER_TIME_ZONE = / [A-Z]{2,5}$/;
const NO_SUCH_IMAGE = /no such image|image not known|image not found/i;

export function systemUsageArguments(): string[] {
  return ["system", "df", "--verbose", "--format", "json"];
}

export function removeImageArguments(reference: string): string[] {
  return ["image", "rm", reference];
}

export function ownedImageArguments(owner: string): string[] {
  return [
    "image",
    "ls",
    "--all",
    "--no-trunc",
    "--filter",
    `label=${OWNER_LABEL}=${owner}`,
    "--format",
    "{{.ID}}",
  ];
}

export function absentImage(answer: RuntimeAnswer): boolean {
  return answer.code !== SUCCESS_CODE && NO_SUCH_IMAGE.test(answer.stderr);
}

export function imageIdOf(value: string): string {
  const trimmed = value.trim();
  const hex = trimmed.startsWith(IMAGE_ID_PREFIX)
    ? trimmed.slice(IMAGE_ID_PREFIX.length)
    : trimmed;
  return IMAGE_ID_HEX.test(hex) ? `${IMAGE_ID_PREFIX}${hex}` : trimmed;
}

export function sameImage(left: string, right: string): boolean {
  const a = imageIdOf(left);
  const b = imageIdOf(right);
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

export function bytesOf(value: unknown): number {
  if (isNumber(value) && Number.isFinite(value) && value >= NO_BYTES)
    return Math.floor(value);
  if (!isString(value)) return NO_BYTES;
  const match = SIZE_PATTERN.exec(value);
  if (!match) return NO_BYTES;
  const unit = SIZE_UNITS[match[2] ?? "B"] ?? 1;
  return Math.floor(Number(match[1]) * unit);
}

export function timeOf(value: unknown): number | null {
  if (isNumber(value) && Number.isFinite(value) && value > NO_EPOCH)
    return Math.floor(value < SECONDS_LIMIT ? value * MS_PER_SECOND : value);
  if (!isString(value) || !value) return null;
  const parsed = Date.parse(value.replace(DOCKER_TIME_ZONE, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function countOf(value: unknown): number {
  if (isNumber(value) && Number.isSafeInteger(value) && value >= NO_COUNT)
    return value;
  const parsed = isString(value) ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= NO_COUNT ? parsed : NO_COUNT;
}

function firstOf(value: unknown, ...names: string[]): unknown {
  for (const name of names) {
    const found = field(value, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

function sections(stdout: string): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {};
  const documents: unknown[] = [];
  try {
    documents.push(JSON.parse(stdout));
  } catch {
    for (const line of linesOf(stdout)) documents.push(JSON.parse(line));
  }
  for (const document of documents)
    for (const name of ["Images", "Volumes"]) {
      const rows = field(document, name);
      if (Array.isArray(rows)) (merged[name] ??= []).push(...rows);
    }
  return merged;
}

export function parseSystemUsage(
  runtime: ContainerRuntime,
  stdout: string,
): RuntimeUsage {
  const found = sections(stdout);
  const images = new Map<string, RuntimeImageUsage>();
  for (const row of found.Images ?? []) {
    const id = firstOf(row, "ID", "Id", "ImageID", "ImageId");
    if (!filled(id)) continue;
    const key = imageIdOf(id);
    const repository = firstOf(row, "Repository");
    const tag = firstOf(row, "Tag");
    const reference =
      filled(repository) &&
      filled(tag) &&
      repository !== NO_REFERENCE &&
      tag !== NO_REFERENCE
        ? `${repository}:${tag}`
        : null;
    const previous = images.get(key);
    images.set(key, {
      id: key,
      references: [
        ...(previous?.references ?? []),
        ...(reference === null || previous?.references.includes(reference)
          ? []
          : [reference]),
      ],
      created_at: timeOf(firstOf(row, "CreatedAt", "Created")),
      unique_bytes: bytesOf(firstOf(row, "UniqueSize")),
      containers: countOf(firstOf(row, "Containers")),
    });
  }
  const volumes: RuntimeVolumeUsage[] = [];
  for (const row of found.Volumes ?? []) {
    const name = firstOf(row, "Name", "VolumeName");
    if (!filled(name)) continue;
    volumes.push({
      name,
      bytes: bytesOf(firstOf(row, "Size")),
      links: countOf(firstOf(row, "Links")),
    });
  }
  return { runtime, images: [...images.values()], volumes };
}

function numberOrNull(value: unknown): number | null {
  return isNumber(value) && Number.isFinite(value) && value >= NO_BYTES
    ? Math.floor(value)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return filled(value) ? value : null;
}

export function parseRuntimeStore(
  runtime: ContainerRuntime,
  stdout: string,
): RuntimeStoreInfo {
  const info = parseInfo(stdout);
  if (info === null) throw new Error(`${runtime} info answers no object.`);
  const store = firstOf(info, "store", "Store");
  return {
    runtime,
    graph_root: stringOrNull(firstOf(store, "graphRoot", "GraphRoot")),
    graph_root_allocated: numberOrNull(
      firstOf(store, "graphRootAllocated", "GraphRootAllocated"),
    ),
    graph_root_used: numberOrNull(
      firstOf(store, "graphRootUsed", "GraphRootUsed"),
    ),
    docker_root_dir: stringOrNull(field(info, "DockerRootDir")),
    operating_system: stringOrNull(field(info, "OperatingSystem")),
  };
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
      created_at: timeOf(field(volume, "CreatedAt")),
    });
  }
  return listings;
}

export function parseVolume(stdout: string): VolumeState {
  const volumes: unknown = JSON.parse(stdout);
  const volume: unknown = Array.isArray(volumes) ? volumes[0] : undefined;
  const createdAt = field(volume, "CreatedAt");
  const mountPoint = field(volume, "Mountpoint");
  if (!filled(createdAt) || !isString(mountPoint))
    throw new Error("The volume inspection answers no volume.");
  return {
    createdAt,
    labeled: field(volume, "Labels", ID_MAP_KEY) === ID_MAP_VALUE,
    mountPoint,
  };
}

export function idMapOf(
  runtime: ContainerRuntime,
  facts: RuntimeFacts,
  labeled: boolean,
): IdMap {
  if (runtime !== ContainerRuntime.Podman || !facts.rootless) return IdMap.None;
  if (labeled) return IdMap.Auto;
  return facts.platform === LINUX && !facts.remote
    ? IdMap.Unshare
    : IdMap.KeepId;
}

function userNamespaceArguments(idMap: IdMap): string[] {
  if (idMap === IdMap.Auto) return [AUTO_USER_NAMESPACE];
  if (idMap === IdMap.KeepId) return [KEEP_ID_USER_NAMESPACE];
  return [];
}

function labelOption(selinux: boolean): string {
  return selinux ? PRIVATE_LABEL : "";
}

export function migrationArguments(command: MigrationCommand): string[] {
  const fileShare =
    command.facts.platform === MACOS || command.facts.dockerDesktop;
  return [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--name",
    migrateName(command.instanceName),
    "--label",
    `${OWNER_LABEL}=${command.owner}`,
    "--user",
    "0:0",
    ...userNamespaceArguments(command.idMap),
    ...CARRIER_CAPABILITIES,
    "--security-opt=no-new-privileges",
    "--volume",
    `${slotName(command.instanceName)}:${SLOT_HOME}`,
    "--volume",
    `${command.mount}:${MIGRATE_MOUNT}${labelOption(command.facts.selinux)}`,
    "--entrypoint",
    SHELL,
    command.image,
    "-c",
    fileShare ? FILE_SHARE_SCRIPT : HOST_DIRECTORY_SCRIPT,
  ];
}

export function unshareMigrationArguments(
  mountPoint: string,
  mount: string,
): string[] {
  return [
    "unshare",
    SHELL,
    "-c",
    UNSHARE_MIGRATION_SCRIPT,
    "sh",
    mountPoint,
    mount,
  ];
}

export function unshareOwnerArguments(mountPoint: string): string[] {
  return ["unshare", "chown", "-R", "0:0", mountPoint];
}

export function unshareMarkerArguments(mountPoint: string): string[] {
  return ["unshare", "touch", join(mountPoint, CACHE_OWNER_MARKER)];
}

export function cacheOwnerArguments(command: CacheOwnerCommand): string[] {
  return [
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--label",
    `${OWNER_LABEL}=${command.owner}`,
    "--user",
    "0:0",
    ...userNamespaceArguments(command.idMap),
    ...CARRIER_CAPABILITIES,
    "--security-opt=no-new-privileges",
    "--volume",
    `${command.volume}:${CACHE_MOUNT}`,
    "--entrypoint",
    SHELL,
    command.image,
    "-c",
    CACHE_OWNER_SCRIPT,
  ];
}

export function runArguments(command: RunCommand): string[] {
  const name = slotName(command.instanceName);
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
    `${INSTANCE_LABEL}=${command.instanceName}`,
    "--user",
    `${CONTAINER_UID}:${CONTAINER_UID}`,
    ...(command.rootless ? [AUTO_USER_NAMESPACE] : []),
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
    "--volume",
    `${command.sessionDirectory}:${SESSION_MOUNT}${labelOption(command.selinux)}`,
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
  if (!isString(version) || !version)
    return "docker answers no server version. Remove the podman-docker shim, or point docker at a Docker Engine.";
  const client = field(info, "ClientInfo", "Version");
  const major = isString(client) ? Number.parseInt(client, 10) : Number.NaN;
  if (!Number.isSafeInteger(major) || major < MINIMUM_DOCKER_CLIENT_MAJOR)
    return `docker client ${isString(client) ? client : "unknown"} is below ${MINIMUM_DOCKER_CLIENT_MAJOR}. Upgrade the Docker client to ${MINIMUM_DOCKER_CLIENT_MAJOR} or later.`;
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

function securityOption(info: Record<string, unknown>, option: string) {
  const options = field(info, "SecurityOptions");
  return (
    Array.isArray(options) &&
    options.some((entry) => isString(entry) && entry.includes(option))
  );
}

function dockerDesktop(info: Record<string, unknown>): boolean {
  return field(info, "OperatingSystem") === DOCKER_DESKTOP;
}

function rootlessPodman(info: Record<string, unknown>): boolean {
  return field(info, "host", "security", "rootless") === true;
}

function rootful(runtime: ContainerRuntime, info: Record<string, unknown>) {
  if (runtime === ContainerRuntime.Podman)
    return field(info, "host", "security", "rootless") === false;
  if (dockerDesktop(info)) return false;
  return !securityOption(info, ROOTLESS_OPTION);
}

function versionParts(version: string): number[] {
  return version
    .split(VERSION_SEPARATOR)
    .map((part) => Number.parseInt(part, 10));
}

export function versionBelow(version: string, minimum: string): boolean {
  const parts = versionParts(version);
  const floor = versionParts(minimum);
  for (const [index, least] of floor.entries()) {
    const part = parts[index];
    if (part === undefined || !Number.isSafeInteger(part)) return true;
    if (part !== least) return part < least;
  }
  return false;
}

function refusal(
  host: RuntimeHost,
  runtime: ContainerRuntime,
  info: Record<string, unknown>,
): string | null {
  if (
    runtime === ContainerRuntime.Podman &&
    rootlessPodman(info) &&
    !coversContainerUid(info)
  )
    return `the subordinate uid range of ${host.user} does not cover the container uid ${CONTAINER_UID}. Add a subordinate uid range of at least ${CONTAINER_UID} ids for ${host.user}.`;
  if (
    runtime === ContainerRuntime.Docker &&
    host.platform === LINUX &&
    !dockerDesktop(info) &&
    securityOption(info, ROOTLESS_OPTION)
  )
    return `rootless Docker cannot map the container uid ${CONTAINER_UID} to the server user. Use rootless Podman or a rootful runtime.`;
  const version = field(info, "version", "Version");
  if (
    runtime === ContainerRuntime.Podman &&
    (!isString(version) || versionBelow(version, PODMAN_MIN_VERSION))
  )
    return `podman ${isString(version) ? version : "unknown"} is below the required version ${PODMAN_MIN_VERSION}. Upgrade Podman to ${PODMAN_MIN_VERSION} or later.`;
  return null;
}

function factsOf(
  host: RuntimeHost,
  runtime: ContainerRuntime,
  info: Record<string, unknown>,
): RuntimeFacts {
  if (runtime === ContainerRuntime.Podman)
    return {
      rootless: rootlessPodman(info),
      selinux: field(info, "host", "security", "selinuxEnabled") === true,
      platform: host.platform,
      dockerDesktop: false,
      remote: field(info, "host", "serviceIsRemote") === true,
    };
  return {
    rootless: securityOption(info, ROOTLESS_OPTION),
    selinux: securityOption(info, SELINUX_OPTION),
    platform: host.platform,
    dockerDesktop: dockerDesktop(info),
    remote: false,
  };
}

function answered(
  host: RuntimeHost,
  runtime: ContainerRuntime,
  info: Record<string, unknown>,
): RuntimeCheck {
  const refused = refusal(host, runtime, info);
  if (refused !== null)
    return {
      status: status(
        PlacementIssue.RuntimeFailed,
        boundedDetail(refused),
        runtime,
      ),
      facts: null,
    };
  if (
    host.platform === LINUX &&
    host.uid !== ROOT_UID &&
    rootful(runtime, info)
  )
    return {
      status: status(PlacementIssue.RuntimeRootful, null, runtime),
      facts: null,
    };
  return {
    status: status(null, null, runtime),
    facts: factsOf(host, runtime, info),
  };
}

export async function detectRuntime(host: RuntimeHost): Promise<RuntimeCheck> {
  if (
    SERVER_IN_CONTAINER_MARKERS.some((path) => host.exists(path)) ||
    host.environment[KUBERNETES_VARIABLE] !== undefined
  )
    return {
      status: status(PlacementIssue.ServerInContainer, null, null),
      facts: null,
    };
  const runtimes = RUNTIME_ORDER.filter((runtime) => host.resolves(runtime));
  if (!runtimes.length)
    return {
      status: status(PlacementIssue.RuntimeAbsent, null, null),
      facts: null,
    };
  let firstFailure: string | null = null;
  for (const runtime of runtimes) {
    const result = await attempt(host, runtime);
    if (result.info) return answered(host, runtime, result.info);
    firstFailure ??= result.detail;
  }
  return {
    status: status(PlacementIssue.RuntimeFailed, firstFailure, null),
    facts: null,
  };
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
  return (runtime, args, timeoutMs, signal) =>
    new Promise((resolve) => {
      execFile(
        runtime,
        args,
        { env: environment, timeout: timeoutMs, encoding: "utf8", signal },
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
