import {
  PLATFORM_HOSTS,
  type PlatformHosts,
} from "../kernel/platform-hosts.ts";
import { RepositoryPlatform } from "../project/contract.ts";

const PLATFORM_HOST_TABLE: Readonly<Record<RepositoryPlatform, PlatformHosts>> =
  PLATFORM_HOSTS;
const SSH_HOST_SETS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(PLATFORM_HOST_TABLE).map(([platform, hosts]) => [
    platform,
    new Set(hosts.ssh),
  ]),
);
const SSH_DEFAULT_PORT = 22;
const SSH_ALTERNATIVE_PORT = 443;
const SSH_HOST_PORTS: ReadonlyMap<string, number> = new Map([
  ["ssh.github.com", SSH_ALTERNATIVE_PORT],
  ["altssh.gitlab.com", SSH_ALTERNATIVE_PORT],
  ["altssh.bitbucket.org", SSH_ALTERNATIVE_PORT],
]);
const GIT_ONLY_PLATFORMS: ReadonlySet<string> = new Set([
  RepositoryPlatform.GitLab,
  RepositoryPlatform.Bitbucket,
]);

export function isPlatformSshHost(platform: string, hostname: string): boolean {
  return SSH_HOST_SETS.get(platform)?.has(hostname.toLowerCase()) ?? false;
}

export function isGitOnlyPlatform(platform: string): boolean {
  return GIT_ONLY_PLATFORMS.has(platform);
}

export function isSshHost(hostname: string): boolean {
  return [...SSH_HOST_SETS.keys()].some((platform) =>
    isPlatformSshHost(platform, hostname),
  );
}

export function isGitHubSshHost(hostname: string): boolean {
  return isPlatformSshHost(RepositoryPlatform.GitHub, hostname);
}

export function sshPortOf(hostname: string): number {
  return SSH_HOST_PORTS.get(hostname.toLowerCase()) ?? SSH_DEFAULT_PORT;
}

export function sshKnownHostsName(hostname: string): string {
  const port = sshPortOf(hostname);
  const name = hostname.toLowerCase();
  return port === SSH_DEFAULT_PORT ? name : `[${name}]:${port}`;
}
