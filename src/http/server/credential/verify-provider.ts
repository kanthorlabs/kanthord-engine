import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type {
  VerifyProviderInput,
  VerifyProviderResult,
} from "../../../queries/provider/verify-provider.ts";
import { toHttpError } from "./refusals.ts";

export type VerifyProviderHandlerDependencies = Readonly<{
  verifyProvider: (input: VerifyProviderInput) => Promise<VerifyProviderResult>;
}>;

export function verifyProviderHandler(
  dependencies: VerifyProviderHandlerDependencies,
): Handler {
  return async (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no provider id in the request path");
    }
    try {
      const result = await dependencies.verifyProvider({
        id,
        signal: AbortSignal.timeout(60_000),
      });
      return { kind: "json", status: 200, body: result };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
