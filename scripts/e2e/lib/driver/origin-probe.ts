import type { CommandRecord } from "../command.ts";

export type OriginProbeInput = Readonly<{
  origin: string;
  username: string;
  tokenPath: string;
  wrongToken: string;
  defaultBranch: string;
}>;

export type ProbeRow = Readonly<{ name: string; passed: boolean }>;

export const originProbeRowNames = [
  "fixture-head-symref",
  "fixture-fetch",
  "fixture-receive-pack-refuses-wrong-token",
] as const;

function rightHelper(username: string, tokenPath: string): string {
  return `!f() { echo username=${username}; echo "password=$(cat ${tokenPath})"; }; f`;
}

function wrongHelper(username: string, wrongToken: string): string {
  return `!f() { echo username=${username}; echo password=${wrongToken}; }; f`;
}

export function originProbeScripts(
  input: OriginProbeInput,
): readonly Readonly<{ name: string; script: string }>[] {
  const { origin, username, tokenPath, wrongToken, defaultBranch } = input;
  const right = rightHelper(username, tokenPath);
  const wrong = wrongHelper(username, wrongToken);

  return [
    {
      name: "fixture-head-symref",
      script: `GIT_TERMINAL_PROMPT=0 git -c 'credential.helper=${right}' ls-remote --symref '${origin}' HEAD`,
    },
    {
      name: "fixture-fetch",
      script: `set -e; d=$(mktemp -d); git init -q --template= "$d"; GIT_TERMINAL_PROMPT=0 git -C "$d" -c 'credential.helper=${right}' fetch --no-tags --prune '${origin}' 'refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}'; git -C "$d" rev-parse 'refs/remotes/origin/${defaultBranch}' >/dev/null; test -z "$(git -C "$d" for-each-ref --format='%(refname)' refs/heads refs/tags)"; rm -rf "$d"`,
    },
    {
      name: "fixture-receive-pack-refuses-wrong-token",
      script: `set -e; d=$(mktemp -d); git init -q --template= "$d"; git -C "$d" -c user.name=probe -c user.email=probe@example.invalid commit -q --allow-empty -m probe; set +e; GIT_TERMINAL_PROMPT=0 git -C "$d" -c 'credential.helper=${wrong}' push --dry-run '${origin}' HEAD:refs/heads/kanthord-e2e-probe; status=$?; rm -rf "$d"; exit $status`,
    },
  ];
}

export async function runOriginProbe(
  runShell: (script: string) => Promise<CommandRecord>,
  input: OriginProbeInput,
): Promise<readonly ProbeRow[]> {
  const scripts = originProbeScripts(input);
  const rows: ProbeRow[] = [];

  for (const [index, entry] of scripts.entries()) {
    const record = await runShell(entry.script);
    const passed = index === 2 ? record.exitCode !== 0 : record.exitCode === 0;
    rows.push({ name: entry.name, passed });
  }

  return rows;
}
