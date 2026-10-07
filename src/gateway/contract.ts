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
import {
  componentHealthSchema,
  ResourceStatus,
  type ResourceEntry,
} from "../kernel/health.ts";
import type { Transaction } from "../kernel/store.ts";
import { HttpMethod, HttpStatus, MediaType } from "../kernel/http.ts";
export const HEALTHCHECK_OK = "ok" as const;
export const MAX_CONCURRENT_CHECKS = 32;
export const RESOURCE_CHECK_DEADLINE_MS = 10000;
export const REPORT_MARGIN_MS = 5000;
export const OWNER_LLM = "llm";
export const OWNER_REPOSITORY = "repository";
export const OWNER_STORAGE = "storage";
export const OWNER_AGENT = "agent";
export const OWNER_WORKER = "worker";
export const OWNER_PROJECT = "project";
export const OWNER_INTAKE = "intake";

export type InventoryOwner =
  | typeof OWNER_LLM
  | typeof OWNER_REPOSITORY
  | typeof OWNER_STORAGE
  | typeof OWNER_AGENT
  | typeof OWNER_WORKER
  | typeof OWNER_PROJECT
  | typeof OWNER_INTAKE;
export interface ResourceInventories {
  llm: (tx: Transaction) => ResourceEntry[];
  repository: (tx: Transaction) => ResourceEntry[];
  storage: (tx: Transaction) => ResourceEntry[];
  agent: (tx: Transaction) => ResourceEntry[];
  worker: (tx: Transaction) => ResourceEntry[];
  project: (tx: Transaction) => ResourceEntry[];
  intake: (tx: Transaction) => ResourceEntry[];
}
export interface InventorySnapshot {
  entries: { owner: InventoryOwner; entry: ResourceEntry }[];
  missing_inventories: InventoryOwner[];
}
export type InventoryCollector = () => InventorySnapshot;

export const resourceEntrySchema = z.strictObject({
  status: z.enum([
    ResourceStatus.Healthy,
    ResourceStatus.Unhealthy,
    ResourceStatus.Unknown,
  ]),
  capability: z.string().min(1),
});
const resourceMapSchema = z.record(z.string().min(1), resourceEntrySchema);
const ownerSchema = z
  .strictObject({
    global: resourceMapSchema,
    projects: z.record(z.string().min(1), resourceMapSchema),
  })
  .meta({ id: "ResourceHealthOwner" });

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
  liveness: {
    ...base,
    id: "gateway.liveness",
    method: HttpMethod.Get,
    path: "/api/liveness",
    input: emptyInput,
    output: z.strictObject({
      status: z.literal(HEALTHCHECK_OK),
      services: z.record(z.string(), componentHealthSchema),
    }),
    description:
      "Report component liveness for every registered service, including the server's SQLite store and log. Any unavailable service or component returns 503 with the complete service map in error.details.",
  },
  healthcheck: {
    ...base,
    id: "gateway.healthcheck",
    method: HttpMethod.Get,
    path: "/api/healthcheck",
    access: AccessPolicy.Human,
    timeoutMs: 120000,
    input: emptyInput,
    output: z.strictObject({
      services: z.strictObject({
        project: ownerSchema,
        intake: ownerSchema,
        worker: ownerSchema,
      }),
      shared: z.strictObject({
        llm: ownerSchema,
        repository: ownerSchema,
        storage: ownerSchema,
        agent: ownerSchema,
      }),
    }),
    description:
      "Check resource health on demand, grouped by owner and scope. Returns every inventory entry with status and capability, including unknown for unfinished checks. A missing inventory returns 503 with missing_inventories in error.details.",
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
