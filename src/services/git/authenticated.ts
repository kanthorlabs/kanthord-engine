import type { GitCredential, GitPaths } from "./index.ts";
import type { GitRunRequest, GitRunResult, GitRunner } from "./run.ts";
import { credentialArgs, openCredentialSession } from "./credential.ts";

export type AuthenticatedRequest = GitRunRequest &
  Readonly<{ credential: GitCredential }>;

export type AuthenticatedOutcome = GitRunResult &
  Readonly<{ eraseObserved: boolean }>;

export async function runAuthenticated(
  runner: GitRunner,
  paths: GitPaths,
  request: AuthenticatedRequest,
): Promise<AuthenticatedOutcome> {
  const session = openCredentialSession(paths, request.credential);
  try {
    const { credential, ...runRequest } = request;
    const result = await runner({
      ...runRequest,
      args: [...credentialArgs(paths, request.credential), ...request.args],
      extraEnv: { ...request.extraEnv, ...session.extraEnv },
    });
    return { ...result, eraseObserved: session.eraseObserved() };
  } finally {
    session.dispose();
  }
}
