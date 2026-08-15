import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { actorRegisterRequest } from "../../contract/actor.ts";
import type {
  RegisterActorInput,
  RegisterActorResult,
} from "../../../commands/actor/register-actor.ts";
import { toHttpError } from "./refusals.ts";

export type RegisterActorHandlerDependencies = Readonly<{
  registerActor: (input: RegisterActorInput) => RegisterActorResult;
  configuredToken: string;
}>;

export function registerActorHandler(
  dependencies: RegisterActorHandlerDependencies,
): Handler {
  return (context) => {
    const parsed = actorRegisterRequest.safeParse(context.body);
    if (!parsed.success) {
      throw httpError(
        "invalid-request",
        "the actor registration body is invalid",
      );
    }
    try {
      const result = dependencies.registerActor({
        name: parsed.data.name,
        actor: context.actor,
        configuredToken: dependencies.configuredToken,
      });
      return { status: 200, body: { ...result.view, token: result.token } };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
