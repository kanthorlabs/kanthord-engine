import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { repositoryRegisterRequest } from "../../contract/repository.ts";
import type { RegisterRepositoryInput } from "../../../commands/repository/register-repository.ts";
import type { RepositoryView } from "../../../domain/repository.ts";
import { toHttpError } from "./refusals.ts";

export type RegisterRepositoryHandlerDependencies = Readonly<{
  registerRepository: (
    input: RegisterRepositoryInput,
  ) => Promise<RepositoryView>;
}>;

export function registerRepositoryHandler(
  dependencies: RegisterRepositoryHandlerDependencies,
): Handler {
  return async (context) => {
    const parsed = repositoryRegisterRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the repository registration body is invalid",
        parsed.error,
      );
    }
    try {
      const view = await dependencies.registerRepository({
        name: parsed.data.name,
        remoteUrl: parsed.data.remoteUrl,
        credentialId: parsed.data.credentialId,
        branch: parsed.data.branch,
        publishOnApproval: parsed.data.publishOnApproval,
        hostFingerprint: parsed.data.hostFingerprint,
        actor: context.actor.id,
      });
      return { kind: "json", status: 200, body: view };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
