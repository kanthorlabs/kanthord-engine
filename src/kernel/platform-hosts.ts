export interface PlatformHosts {
  ssh: readonly string[];
  api: string;
}

export const PLATFORM_HOSTS = {
  github: { ssh: ["github.com", "ssh.github.com"], api: "api.github.com" },
  gitlab: { ssh: ["gitlab.com", "altssh.gitlab.com"], api: "gitlab.com" },
  bitbucket: {
    ssh: ["bitbucket.org", "altssh.bitbucket.org"],
    api: "api.bitbucket.org",
  },
} as const satisfies Record<string, PlatformHosts>;

export function platformNetworkHosts(): string[] {
  return [
    ...new Set(
      Object.values(PLATFORM_HOSTS).flatMap((hosts) => [
        ...hosts.ssh,
        hosts.api,
      ]),
    ),
  ];
}
