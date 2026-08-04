import { runAcceptance } from "./acceptance.ts";
import type { AcceptanceCheck } from "./acceptance.ts";
import {
  httpAcceptanceChecks,
  httpCredentials,
  httpWrongCredential,
  startHttpRemote,
} from "./http.ts";
import type { FixtureCredential, HttpRemote } from "./http.ts";
import { sshAcceptanceChecks, startSshRemote } from "./ssh.ts";
import type { FixtureHostKey, SshRemote } from "./ssh.ts";
import { seedRepositories } from "./seed.ts";
import type { SeededRepository, SeedRoot } from "./seed.ts";
import { resolveTools } from "./tools.ts";
import type { Tools } from "./tools.ts";

export type FixtureTransport = "http-basic" | "ssh";

export const fixtureTransports: readonly FixtureTransport[] = [
  "http-basic",
  "ssh",
] as const;

export type RemoteOverrides<T> = Readonly<{
  checks?: readonly AcceptanceCheck<T>[];
  env?: Readonly<Record<string, string | undefined>>;
}>;

export type Remotes = Readonly<{
  http: HttpRemote;
  ssh: SshRemote;
  dispose(): Promise<void>;
}>;

async function gatedHttpRemote(
  tools: Tools,
  seed: SeedRoot,
  checks: readonly AcceptanceCheck<HttpRemote>[],
): Promise<HttpRemote> {
  const remote = await startHttpRemote(tools, seed);
  try {
    await runAcceptance("http-basic", remote, checks);
  } catch (error) {
    await remote.dispose();
    throw error;
  }
  return remote;
}

async function gatedSshRemote(
  tools: Tools,
  seed: SeedRoot,
  checks: readonly AcceptanceCheck<SshRemote>[],
): Promise<SshRemote> {
  const remote = await startSshRemote(tools, seed);
  try {
    await runAcceptance("ssh", remote, checks);
  } catch (error) {
    await remote.dispose();
    throw error;
  }
  return remote;
}

export async function createHttpRemote(
  overrides?: RemoteOverrides<HttpRemote>,
): Promise<HttpRemote> {
  const tools = resolveTools(overrides?.env);
  const seed = seedRepositories(tools);
  try {
    const remote = await gatedHttpRemote(
      tools,
      seed,
      overrides?.checks ?? httpAcceptanceChecks,
    );
    return {
      ...remote,
      dispose: async () => {
        try {
          await remote.dispose();
        } finally {
          seed.dispose();
        }
      },
    };
  } catch (error) {
    seed.dispose();
    throw error;
  }
}

export async function createSshRemote(
  overrides?: RemoteOverrides<SshRemote>,
): Promise<SshRemote> {
  const tools = resolveTools(overrides?.env);
  const seed = seedRepositories(tools);
  try {
    const remote = await gatedSshRemote(
      tools,
      seed,
      overrides?.checks ?? sshAcceptanceChecks,
    );
    return {
      ...remote,
      dispose: async () => {
        try {
          await remote.dispose();
        } finally {
          seed.dispose();
        }
      },
    };
  } catch (error) {
    seed.dispose();
    throw error;
  }
}

export async function createRemotes(): Promise<Remotes> {
  const tools = resolveTools({});
  const seed = seedRepositories(tools);
  try {
    const http = await gatedHttpRemote(tools, seed, httpAcceptanceChecks);
    try {
      const ssh = await gatedSshRemote(tools, seed, sshAcceptanceChecks);
      return {
        http,
        ssh,
        async dispose(): Promise<void> {
          const results = await Promise.allSettled([
            http.dispose(),
            ssh.dispose(),
          ]);
          seed.dispose();
          for (const result of results) {
            if (result.status === "rejected") {
              throw result.reason;
            }
          }
        },
      };
    } catch (error) {
      await http.dispose();
      seed.dispose();
      throw error;
    }
  } catch (error) {
    seed.dispose();
    throw error;
  }
}

export { FixtureError } from "./acceptance.ts";
export type { AcceptanceCheck } from "./acceptance.ts";
export { httpCredentials, httpWrongCredential } from "./http.ts";
export type { FixtureCredential, HttpRemote } from "./http.ts";
export type { FixtureHostKey, SshRemote } from "./ssh.ts";
export { fixtureObjectIds } from "./seed.ts";
export type { SeededRepository } from "./seed.ts";
