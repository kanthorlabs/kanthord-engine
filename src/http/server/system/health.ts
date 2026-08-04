import type { Handler } from "../app.ts";
import type { ReadHealthResult } from "../../../queries/system/read-health.ts";

export type HealthHandlerDependencies = Readonly<{
  readHealth: () => ReadHealthResult;
}>;

export function healthHandler(
  dependencies: HealthHandlerDependencies,
): Handler {
  return () => ({ status: 200, body: dependencies.readHealth() });
}
