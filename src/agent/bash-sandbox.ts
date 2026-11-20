import assert from "node:assert/strict";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { platformNetworkHosts } from "../kernel/platform-hosts.ts";
import { directories } from "../kernel/xdg.ts";
import { piDirectory } from "./pi.ts";

const NPM_REGISTRY_HOST = "registry.npmjs.org";
const TEMPORARY_FALLBACK = "/tmp";
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];
const UNAVAILABLE = "the bash sandbox is not available";
const WORKERS_DIRECTORY = "workers";
const LOG_FILE = "kanthord.log";
const PROJECTS_DIRECTORY = "projects";
const ENVIRONMENTS_DIRECTORY = "environments";
const PARENT_SEGMENT = "..";
const DATABASE_FILES = ["kanthord.db", "kanthord.db-wal", "kanthord.db-shm"];

const BASH_NETWORK: SandboxRuntimeConfig["network"] = {
  allowedDomains: [NPM_REGISTRY_HOST, ...platformNetworkHosts()],
  deniedDomains: [],
};

const DEFAULT_CONFIG: SandboxRuntimeConfig = {
  network: BASH_NETWORK,
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowWrite: [],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

type Runtime = Pick<typeof SandboxManager, "initialize" | "wrapWithSandbox">;

function overriddenConfigFile(env: NodeJS.ProcessEnv): string[] {
  const override = env.KANTHORD_CONFIG;
  return override ? [resolve(override)] : [];
}

export interface SandboxHost {
  env: NodeJS.ProcessEnv;
  denyRead: readonly string[];
}

export interface DenyReadScope {
  pi?: string;
  root?: string;
}

function isWithin(ancestor: string, path: string): boolean {
  if (!isAbsolute(ancestor)) return false;
  const inside = relative(ancestor, path);
  return (
    inside !== PARENT_SEGMENT &&
    !inside.startsWith(`${PARENT_SEGMENT}${sep}`) &&
    !isAbsolute(inside)
  );
}

function withoutAncestors(
  denyRead: readonly string[],
  paths: readonly string[],
): string[] {
  return denyRead.filter(
    (denied) => !paths.some((path) => isWithin(denied, path)),
  );
}

export function hostDenyRead(
  env: NodeJS.ProcessEnv,
  scope: DenyReadScope = {},
): string[] {
  const place = directories(env);
  const denyRead = [
    ...DEFAULT_CONFIG.filesystem.denyRead,
    piDirectory(env),
    ...(scope.pi === undefined ? [] : [scope.pi]),
    join(place.state, WORKERS_DIRECTORY),
    join(place.state, LOG_FILE),
    place.config,
    ...overriddenConfigFile(env),
    place.data,
    ...DATABASE_FILES.map((file) => join(place.data, file)),
    join(place.state, PROJECTS_DIRECTORY),
    join(place.state, ENVIRONMENTS_DIRECTORY),
    "~/.config/kanthord-eval",
    "~/.pi/agent",
  ];
  return scope.root === undefined
    ? denyRead
    : withoutAncestors(denyRead, [scope.root]);
}

function filesystemOf(
  denyRead: string[],
  allowWrite: string[],
): SandboxRuntimeConfig["filesystem"] {
  return { ...DEFAULT_CONFIG.filesystem, denyRead, allowWrite };
}

export function createBashSandbox(
  runtime: Runtime,
  platform: NodeJS.Platform = process.platform,
) {
  let started: Promise<void> | undefined;
  const start = async (
    filesystem: SandboxRuntimeConfig["filesystem"],
  ): Promise<void> => {
    if (!SUPPORTED_PLATFORMS.includes(platform))
      throw new Error(
        `${UNAVAILABLE}: the platform ${platform} is unsupported`,
      );
    try {
      await runtime.initialize({
        ...DEFAULT_CONFIG,
        filesystem,
      });
    } catch (cause) {
      throw new Error(
        `${UNAVAILABLE}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
  };
  return {
    async wrap(
      command: string,
      cwd: string,
      host: SandboxHost,
    ): Promise<string> {
      assert.ok(cwd);
      const temporary = host.env.TMPDIR ?? TEMPORARY_FALLBACK;
      const denied = withoutAncestors(host.denyRead, [cwd, temporary]);
      started ??= start(filesystemOf(denied, []));
      await started;
      return runtime.wrapWithSandbox(command, undefined, {
        filesystem: filesystemOf(denied, [cwd, temporary]),
        network: BASH_NETWORK,
      });
    },
  };
}

export const bashSandbox = createBashSandbox(SandboxManager);
