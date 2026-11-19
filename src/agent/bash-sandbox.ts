import assert from "node:assert/strict";
import { join } from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { platformNetworkHosts } from "../kernel/platform-hosts.ts";
import { directories } from "../kernel/xdg.ts";
import { piAgentDirectory } from "./pi.ts";

const NPM_REGISTRY_HOST = "registry.npmjs.org";
const TEMPORARY_FALLBACK = "/tmp";
const SUPPORTED_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];
const UNAVAILABLE = "the bash sandbox is not available";
const WORKERS_DIRECTORY = "workers";
const LOG_FILE = "kanthord.log";
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

function configurationOf(
  allowWrite: string[],
): SandboxRuntimeConfig["filesystem"] {
  const place = directories(process.env);
  return {
    ...DEFAULT_CONFIG.filesystem,
    denyRead: [
      ...DEFAULT_CONFIG.filesystem.denyRead,
      piAgentDirectory(),
      join(place.state, WORKERS_DIRECTORY),
      join(place.state, LOG_FILE),
      place.config,
      ...DATABASE_FILES.map((name) => join(place.data, name)),
      "~/.config/kanthord-eval",
      "~/.pi/agent",
    ],
    allowWrite,
  };
}

export function createBashSandbox(
  runtime: Runtime,
  platform: NodeJS.Platform = process.platform,
) {
  let started: Promise<void> | undefined;
  const start = async (): Promise<void> => {
    if (!SUPPORTED_PLATFORMS.includes(platform))
      throw new Error(
        `${UNAVAILABLE}: the platform ${platform} is unsupported`,
      );
    try {
      await runtime.initialize({
        ...DEFAULT_CONFIG,
        filesystem: configurationOf([]),
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
      env: NodeJS.ProcessEnv,
    ): Promise<string> {
      assert.ok(cwd);
      started ??= start();
      await started;
      return runtime.wrapWithSandbox(command, undefined, {
        filesystem: configurationOf([cwd, env.TMPDIR ?? TEMPORARY_FALLBACK]),
        network: BASH_NETWORK,
      });
    },
  };
}

export const bashSandbox = createBashSandbox(SandboxManager);
