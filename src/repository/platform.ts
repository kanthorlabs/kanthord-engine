import { RepositoryPlatform } from "../project/contract.ts";

const SSH_HOST_SETS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [RepositoryPlatform.GitHub, new Set(["github.com", "ssh.github.com"])],
  [RepositoryPlatform.GitLab, new Set(["gitlab.com", "altssh.gitlab.com"])],
  [
    RepositoryPlatform.Bitbucket,
    new Set(["bitbucket.org", "altssh.bitbucket.org"]),
  ],
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
