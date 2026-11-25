import assert from "node:assert/strict";
import { type Dirent, readdirSync, realpathSync } from "node:fs";
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
const MISSING_ENTRY = "ENOENT";
const PARENT_SEGMENT = "..";
const DATABASE_FILES = ["kanthord.db", "kanthord.db-wal", "kanthord.db-shm"];
const EVAL_AUTH_FILE_VARIABLE = "EVAL_ANTHROPIC_AUTH_FILE";
const GITHUB_ASSET_HOSTS = [
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];
const GIT_DIRECTORY = ".git";
const GIT_SEARCH_DEPTH = 3;
const GIT_SEARCH_END = 0;
const GIT_PROTECTED_ENTRIES = ["config", "hooks"];
const SINGLE_QUOTE = /'/g;
const QUOTED_SINGLE_QUOTE = "'\\''";

const BASH_NETWORK: SandboxRuntimeConfig["network"] = {
  allowedDomains: [
    NPM_REGISTRY_HOST,
    ...GITHUB_ASSET_HOSTS,
    ...platformNetworkHosts(),
  ],
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

type Runtime = Pick<
  typeof SandboxManager,
  "initialize" | "wrapWithSandbox" | "reset"
>;

function overriddenConfigFile(env: NodeJS.ProcessEnv): string[] {
  const override = env.KANTHORD_CONFIG;
  return override ? [resolve(override)] : [];
}

function realTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === MISSING_ENTRY) return path;
    throw error;
  }
}

function evalAuthFile(env: NodeJS.ProcessEnv): string[] {
  const file = env[EVAL_AUTH_FILE_VARIABLE];
  if (!file || !isAbsolute(file)) return [];
  return [...new Set([file, realTarget(file)])];
}

export interface SandboxScope {
  denyRead: readonly string[];
  root?: string;
}

export interface SandboxHost extends SandboxScope {
  env: NodeJS.ProcessEnv;
}

export interface DenyReadScope {
  pi?: string;
  config?: string;
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

function entriesOf(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === MISSING_ENTRY) return [];
    throw error;
  }
}

function besideRoot(ancestor: string, root: string): string[] {
  return entriesOf(ancestor).flatMap((entry) => {
    const child = join(ancestor, entry.name);
    if (!isWithin(child, root)) return [child];
    return isWithin(root, child) ? [] : besideRoot(child, root);
  });
}

function rootDenyRead(host: SandboxHost): string[] {
  const { root } = host;
  if (root === undefined) return [];
  return host.denyRead
    .filter((denied) => isWithin(denied, root))
    .flatMap((ancestor) => besideRoot(ancestor, root));
}

export function scopedDenyRead(host: SandboxHost, cwd: string): string[] {
  const allowed = [cwd, host.env.TMPDIR ?? TEMPORARY_FALLBACK];
  const roots = host.root === undefined ? [] : [host.root];
  return [
    ...new Set([
      ...withoutAncestors(host.denyRead, [...allowed, ...roots]),
      ...withoutAncestors(rootDenyRead(host), allowed),
    ]),
  ];
}

function gitDirectories(directory: string, depth: number): string[] {
  return entriesOf(directory).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.name === GIT_DIRECTORY)
      return entry.isDirectory() || entry.isSymbolicLink() ? [path] : [];
    if (!entry.isDirectory() || depth === GIT_SEARCH_END) return [];
    return gitDirectories(path, depth - 1);
  });
}

function gitDenyWrite(cwd: string): string[] {
  return gitDirectories(cwd, GIT_SEARCH_DEPTH).flatMap((git) =>
    GIT_PROTECTED_ENTRIES.map((entry) => join(git, entry)),
  );
}

function shellQuoted(word: string): string {
  return `'${word.replace(SINGLE_QUOTE, QUOTED_SINGLE_QUOTE)}'`;
}

export function hostDenyRead(
  env: NodeJS.ProcessEnv,
  scope: DenyReadScope = {},
): string[] {
  const place = directories(env);
  return [
    ...DEFAULT_CONFIG.filesystem.denyRead,
    piDirectory(env),
    ...(scope.pi === undefined ? [] : [scope.pi]),
    join(place.state, WORKERS_DIRECTORY),
    join(place.state, LOG_FILE),
    place.config,
    ...overriddenConfigFile(env),
    ...(scope.config === undefined ? [] : [resolve(scope.config)]),
    ...evalAuthFile(env),
    place.data,
    ...DATABASE_FILES.map((file) => join(place.data, file)),
    join(place.state, PROJECTS_DIRECTORY),
    join(place.state, ENVIRONMENTS_DIRECTORY),
    "~/.config/kanthord-eval",
    "~/.pi/agent",
  ];
}

function filesystemOf(
  denyRead: string[],
  allowWrite: string[],
  denyWrite: string[],
): SandboxRuntimeConfig["filesystem"] {
  return {
    ...DEFAULT_CONFIG.filesystem,
    denyRead,
    allowWrite,
    denyWrite: [...DEFAULT_CONFIG.filesystem.denyWrite, ...denyWrite],
  };
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
      const denied = scopedDenyRead(host, cwd);
      const gitDenied = gitDenyWrite(cwd);
      started ??= start(filesystemOf(denied, [], gitDenied));
      await started;
      return runtime.wrapWithSandbox(
        `export TMPDIR=${shellQuoted(temporary)}; ${command}`,
        undefined,
        {
          filesystem: filesystemOf(denied, [cwd, temporary], gitDenied),
          network: BASH_NETWORK,
        },
      );
    },
    async dispose(): Promise<void> {
      await runtime.reset();
      started = undefined;
    },
  };
}

export const bashSandbox = createBashSandbox(SandboxManager);
