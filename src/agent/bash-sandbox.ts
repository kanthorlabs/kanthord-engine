import assert from "node:assert/strict";
import {
  accessSync,
  constants,
  type Dirent,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
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
const UNRESOLVABLE_ENTRY_CODES = [
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "ELOOP",
];
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
const PNPM_STORE_DIRECTORY = "pnpm-store";
const PNPM_CACHE_DIRECTORY = "pnpm-cache";
const NPM_CACHE_DIRECTORY = "npm-cache";
const GIT_USER_FILE = ".gitconfig";
const USER_CONFIG_DIRECTORY = ".config";
const GIT_CONFIG_DIRECTORY = "git";
const HOME_PREFIX = "~/";
const NODE_EXECUTABLE = "node";
const PROJECT_PACKAGES_DIRECTORY = "node_modules";
const COMMAND_VARIABLE = "KANTHORD_BASH_COMMAND";
const SANDBOXED_COMMAND = `eval "$${COMMAND_VARIABLE}"`;
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

const CREDENTIAL_DIRECTORIES = ["~/.ssh", "~/.aws", "~/.gnupg"];
const PROTECTED_FILES = [".env", ".env.*", "*.pem", "*.key"];

const DEFAULT_CONFIG: SandboxRuntimeConfig = {
  network: BASH_NETWORK,
  filesystem: {
    denyRead: CREDENTIAL_DIRECTORIES,
    allowWrite: [],
    denyWrite: PROTECTED_FILES,
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

function resolvedOrSame(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code !== undefined && UNRESOLVABLE_ENTRY_CODES.includes(code))
      return path;
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

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME !== undefined && isAbsolute(env.HOME) ? env.HOME : homedir();
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? "").split(delimiter).filter(isAbsolute);
}

function inProjectPackages(path: string): boolean {
  return path.split(sep).includes(PROJECT_PACKAGES_DIRECTORY);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function nodePrefix(entries: readonly string[]): string[] {
  const directory = entries.find((entry) =>
    isExecutable(join(entry, NODE_EXECUTABLE)),
  );
  if (directory === undefined) return [];
  return [dirname(dirname(resolvedOrSame(join(directory, NODE_EXECUTABLE))))];
}

function toolRoots(env: NodeJS.ProcessEnv, home: string): string[] {
  const entries = pathEntries(env).filter((entry) => !inProjectPackages(entry));
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : join(home, USER_CONFIG_DIRECTORY);
  const roots = [
    ...entries,
    ...entries.map(resolvedOrSame),
    join(home, GIT_USER_FILE),
    join(configHome, GIT_CONFIG_DIRECTORY),
    ...nodePrefix(entries),
  ];
  return [...new Set(roots.filter((root) => isWithin(home, root)))];
}

function instanceRoots(host: SandboxHost): string[] {
  return host.root === undefined ? [] : [host.root];
}

function expandedHome(path: string, home: string): string {
  return path.startsWith(HOME_PREFIX)
    ? join(home, path.slice(HOME_PREFIX.length))
    : path;
}

function outsideHostDeny(host: SandboxHost, home: string, root: string) {
  return !host.denyRead.some((denied) =>
    isWithin(expandedHome(denied, home), root),
  );
}

function keptReadPaths(host: SandboxHost, cwd: string): string[] {
  const home = homeOf(host.env);
  return [
    ...new Set([
      cwd,
      host.env.TMPDIR ?? TEMPORARY_FALLBACK,
      ...instanceRoots(host),
      ...toolRoots(host.env, home).filter((root) =>
        outsideHostDeny(host, home, root),
      ),
    ]),
  ];
}

export function scopedDenyRead(host: SandboxHost, cwd: string): string[] {
  const allowed = [cwd, host.env.TMPDIR ?? TEMPORARY_FALLBACK];
  return [
    ...new Set([
      ...withoutAncestors(host.denyRead, [...allowed, ...instanceRoots(host)]),
      ...withoutAncestors(rootDenyRead(host), allowed),
      homeOf(host.env),
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
    ...CREDENTIAL_DIRECTORIES,
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

function defaultDenyWrite(cwd: string): string[] {
  return PROTECTED_FILES.map((entry) =>
    isAbsolute(entry) ? entry : join(cwd, entry),
  );
}

interface FilesystemRules {
  denyRead: string[];
  allowRead: string[];
  allowWrite: string[];
  denyWrite: string[];
}

function filesystemOf(
  rules: FilesystemRules,
): SandboxRuntimeConfig["filesystem"] {
  return { ...DEFAULT_CONFIG.filesystem, ...rules };
}

function packageCacheExports(temporary: string): string {
  return [
    `pnpm_config_store_dir=${shellQuoted(join(temporary, PNPM_STORE_DIRECTORY))}`,
    `pnpm_config_cache_dir=${shellQuoted(join(temporary, PNPM_CACHE_DIRECTORY))}`,
    `npm_config_cache=${shellQuoted(join(temporary, NPM_CACHE_DIRECTORY))}`,
  ].join(" ");
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
      started ??= start(
        filesystemOf({
          denyRead: denied,
          allowRead: [],
          allowWrite: [],
          denyWrite: gitDenied,
        }),
      );
      await started;
      const sandboxed = await runtime.wrapWithSandbox(
        SANDBOXED_COMMAND,
        undefined,
        {
          filesystem: filesystemOf({
            denyRead: denied,
            allowRead: keptReadPaths(host, cwd),
            allowWrite: [cwd, temporary],
            denyWrite: [...defaultDenyWrite(cwd), ...gitDenied],
          }),
          network: BASH_NETWORK,
        },
      );
      return `export ${COMMAND_VARIABLE}=${shellQuoted(command)} TMPDIR=${shellQuoted(temporary)} ${packageCacheExports(temporary)}; ${sandboxed}`;
    },
    async dispose(): Promise<void> {
      await runtime.reset();
      started = undefined;
    },
  };
}

export const bashSandbox = createBashSandbox(SandboxManager);
