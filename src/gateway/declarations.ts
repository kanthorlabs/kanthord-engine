import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OperationRegistry } from "../kernel/operation.ts";
import { isHumanIdentity } from "../kernel/caller.ts";
import { healthy } from "../kernel/service.ts";
import type { ServiceHealthchecks } from "../kernel/health.ts";
import type { Context } from "../kernel/context.ts";
import { GatewayError, unauthorized } from "./errors.ts";
import { OPENAPI_INDEX_FILE, openAPIFileNames } from "./openapi.ts";
import { gatewayOperations, HEALTHCHECK_OK } from "./contract.ts";
import { openapiPath } from "./local.ts";

const EMPTY_SERVICE_COUNT = 0;

export function registerGatewayOperations(
  registry: OperationRegistry,
  healthcheck: (context: Context) => Promise<ServiceHealthchecks>,
): void {
  registry.register(gatewayOperations.healthcheck, async (_input, caller) => {
    const services = await healthcheck(caller.context);
    const checks = Object.values(services);
    if (checks.length === EMPTY_SERVICE_COUNT || !checks.every(healthy))
      throw new GatewayError(
        503,
        "gateway.healthcheck.unhealthy",
        "One or more services are unavailable.",
        services,
      );
    return { status: HEALTHCHECK_OK, services };
  });
  registry.register(gatewayOperations.verify, (_input, caller) => {
    if (!isHumanIdentity(caller.identity)) throw unauthorized();
    return {
      kind: caller.identity.kind,
      sub: caller.identity.accountId,
      name: caller.identity.name,
    };
  });
  registry.register(gatewayOperations.openapi, () =>
    readOpenAPIFile(OPENAPI_INDEX_FILE),
  );
  registry.register(gatewayOperations.openapiFile, ({ params }) => {
    const file = `openapi/${params.service}/${params.file}`;
    if (
      !openAPIFileNames(
        registry.all().map(({ operation }) => operation),
      ).includes(file)
    )
      throw new GatewayError(
        404,
        "gateway.openapi.not_found",
        "OpenAPI file not found.",
      );
    return readOpenAPIFile(file);
  });
}

async function readOpenAPIFile(file: string): Promise<string> {
  try {
    return await readFile(join(dirname(openapiPath()), file), "utf8");
  } catch {
    throw new GatewayError(
      503,
      "gateway.openapi.unavailable",
      "Published OpenAPI contract is unavailable.",
    );
  }
}
