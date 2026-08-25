import type { Handler } from "../app.ts";
import type {
  ListProviderInput,
  ProviderListItem,
} from "../../../queries/provider/list-provider.ts";

export type ListProviderHandlerDependencies = Readonly<{
  listProviders: (input: ListProviderInput) => readonly ProviderListItem[];
}>;

export function listProviderHandler(
  dependencies: ListProviderHandlerDependencies,
): Handler {
  return () => ({
    kind: "json",
    status: 200,
    body: { providers: dependencies.listProviders({}) },
  });
}
