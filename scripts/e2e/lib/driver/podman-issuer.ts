import type { HttpIssuer } from "./index.ts";
import type { PodmanExecutor } from "./podman.ts";

export function podmanIssuer(
  execute: PodmanExecutor,
  clientContainer: string,
  baseUrl: string,
): HttpIssuer {
  return async (request) => {
    const record = await execute(
      [
        "podman",
        "exec",
        "--interactive",
        clientContainer,
        "node",
        "/opt/e2e/bin/e2e-request.mjs",
      ],
      JSON.stringify({ ...request, baseUrl }),
    );

    const separatorIndex = record.stdout.indexOf("\n");
    const statusText =
      separatorIndex === -1
        ? record.stdout
        : record.stdout.slice(0, separatorIndex);
    const body =
      separatorIndex === -1 ? "" : record.stdout.slice(separatorIndex + 1);

    return { status: Number.parseInt(statusText, 10), body };
  };
}
