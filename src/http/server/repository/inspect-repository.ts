import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { repositoryInspectRequest } from "../../contract/repository.ts";
import type {
  InspectRepositoryInput,
  InspectRepositoryResult,
} from "../../../queries/repository/inspect-repository.ts";
import { toHttpError } from "./refusals.ts";

export type InspectRepositoryHandlerDependencies = Readonly<{
  inspectRepository: (
    input: InspectRepositoryInput,
  ) => Promise<InspectRepositoryResult>;
}>;

export function inspectRepositoryHandler(
  dependencies: InspectRepositoryHandlerDependencies,
): Handler {
  return async (context) => {
    const parsed = repositoryInspectRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the repository inspection body is invalid",
        parsed.error,
      );
    }
    try {
      const result = await dependencies.inspectRepository({
        remoteUrl: parsed.data.remoteUrl,
        credentialId: parsed.data.credentialId,
        requiredAccess: parsed.data.requiredAccess,
      });
      return {
        kind: "json",
        status: 200,
        body: {
          defaultBranch: result.defaultBranch,
          branches: result.branches,
          credential: result.credential,
          hostKey:
            result.hostKey === null
              ? null
              : {
                  algorithm: result.hostKey.algorithm,
                  fingerprint: result.hostKey.fingerprint,
                },
          access: result.access,
        },
      };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
