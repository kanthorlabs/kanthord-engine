import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { providerInspectRequest } from "../../contract/credential.ts";
import type {
  InspectProviderInput,
  InspectProviderResult,
} from "../../../queries/provider/inspect-provider.ts";
import { toHttpError } from "./refusals.ts";

export type InspectProviderHandlerDependencies = Readonly<{
  inspectProvider: (
    input: InspectProviderInput,
  ) => Promise<InspectProviderResult>;
}>;

export function inspectProviderHandler(
  dependencies: InspectProviderHandlerDependencies,
): Handler {
  return async (context) => {
    const parsed = providerInspectRequest.safeParse(context.body);
    if (!parsed.success) {
      throw invalidRequest(
        "body-schema",
        "the provider inspection body is invalid",
        parsed.error,
      );
    }
    try {
      return {
        kind: "json",
        status: 200,
        body: await dependencies.inspectProvider({
          provider: parsed.data.provider,
          baseUrl: parsed.data.baseUrl,
          apiKey: parsed.data.apiKey,
        }),
      };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
