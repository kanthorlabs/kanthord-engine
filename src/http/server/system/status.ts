import type { Handler } from "../app.ts";
import type { ReadStatusResult } from "../../../queries/system/read-status.ts";

export type StatusHandlerDependencies = Readonly<{
  readStatus: () => ReadStatusResult;
}>;

export function statusHandler(
  dependencies: StatusHandlerDependencies,
): Handler {
  return () => ({ status: 200, body: dependencies.readStatus() });
}
