import { z } from "zod";
import {
  emptyInput,
  AccessPolicy,
  StoreName,
  OperationLifetime,
  type Operation,
} from "../kernel/operation.ts";
import {
  IdentityKind,
  MAX_HUMAN_USERNAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
} from "../kernel/caller.ts";
import { componentHealthSchema } from "../kernel/health.ts";
import { HttpMethod, HttpStatus, MediaType } from "../kernel/http.ts";
export const HEALTHCHECK_OK = "ok" as const;

const base = {
  service: "gateway",
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
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
      sub: z.string().min(1).max(MAX_HUMAN_USERNAME_LENGTH),
      name: z
        .string()
        .min(1)
        .max(MAX_DISPLAY_NAME_LENGTH)
        .refine((value) => !!value.trim()),
    }),
    description:
      "Verify the human bearer JWT and return its kind, sub and name claims without aliases, the token or token metadata.",
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
