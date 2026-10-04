const GITHUB_PLATFORM = "github";
const GITHUB_SSH_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "ssh.github.com",
]);
const SSH_HOST_SETS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [GITHUB_PLATFORM, GITHUB_SSH_HOSTS],
]);

export function isPlatformSshHost(platform: string, hostname: string): boolean {
  return SSH_HOST_SETS.get(platform)?.has(hostname.toLowerCase()) ?? false;
}
