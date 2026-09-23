import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { workerOperations } from "../worker/operations.ts";
import {
  emptyInput,
  type Operation,
  type OperationRegistry,
} from "./registry.ts";
import { isHumanIdentity } from "./authentication.ts";
import { GatewayError, unauthorized } from "./errors.ts";
import { healthy } from "../service.ts";
import { componentHealthSchema, type ServiceHealthchecks } from "../health.ts";
import type { Context } from "../context.ts";
import { OPENAPI_INDEX_FILE, openAPIFileNames } from "./openapi.ts";
import {
  AccessPolicy,
  IdentityKind,
  MAX_HUMAN_USERNAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
} from "./constants.ts";
import { HttpMethod, HttpStatus, MediaType } from "../shared/http.ts";

export const HEALTHCHECK_OK = "ok" as const;
const EMPTY_SERVICE_COUNT = 0;

const base = {
  service: "gateway",
  access: AccessPolicy.Public,
  timeoutMs: 30000,
  mutation: false,
  status: HttpStatus.OK,
} as const;
export const gatewayOperations = {
  healthcheck: {
    ...base,
    id: "gateway.healthcheck",
    method: HttpMethod.Get,
    path: "/api/healthcheck",
    input: emptyInput,
    output: z.strictObject({
      status: z.literal(HEALTHCHECK_OK),
      services: z.record(z.string(), componentHealthSchema),
    }),
    description:
      "Report the owned component status of every registered service, including the server's SQLite store and log. Any unavailable service or component returns 503 with the complete service map in error.details.",
  },
  verify: {
    ...base,
    id: "gateway.verify",
    method: HttpMethod.Get,
    path: "/api/auth/verify",
    access: AccessPolicy.Human,
    timeoutMs: 10000,
    input: emptyInput,
    output: z.strictObject({
      kind: z.literal(IdentityKind.Human),
      accountId: z.string().min(1).max(MAX_HUMAN_USERNAME_LENGTH),
      name: z
        .string()
        .min(1)
        .max(MAX_DISPLAY_NAME_LENGTH)
        .refine((value) => !!value.trim()),
    }),
    description:
      "Verify the human bearer JWT and return its authenticated identity without returning the token.",
  },
  openapi: {
    ...base,
    id: "gateway.openapi",
    method: HttpMethod.Get,
    path: "/api/openapi.yaml",
    input: emptyInput,
    output: z.string(),
    contentType: MediaType.YAML,
    description:
      "Read the published OpenAPI contract shipped with this package.",
  },
  openapiFile: {
    ...base,
    id: "gateway.openapiFile",
    method: HttpMethod.Get,
    path: "/api/openapi/:service/:file",
    input: emptyInput.extend({
      params: z.strictObject({
        service: z.string().regex(/^[a-z][a-z0-9-]*$/),
        file: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]*\.yaml$/),
      }),
    }),
    output: z.string(),
    contentType: MediaType.YAML,
    description:
      "Read a service-scoped or shared OpenAPI file referenced by the root contract.",
  },
} as const satisfies Record<string, Operation>;

export const apiOperations = { ...gatewayOperations, ...workerOperations };

export const openapiPath = () =>
  fileURLToPath(new URL("../../static/openapi.yaml", import.meta.url));

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
      accountId: caller.identity.accountId,
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
