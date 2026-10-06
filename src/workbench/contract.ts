import { z } from "zod";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import { reasoningEffortSchema } from "../agent/contract.ts";

export const WORKBENCH_SERVICE_NAME = "workbench";
export const WORKBENCH_SESSION_PREFIX = "workbench_session";
export const WORKBENCH_DIRECTORY_NAME = "workbench";
export const WORKBENCH_CONFIGURATION_ENTRY = "kanthord.workbench.configuration";
export const WORKBENCH_TIMEOUT_MS = 30000;
export const WORKBENCH_MAX_BODY_BYTES = 64 * 1024;

export const WorkbenchErrorCode = {
  Stopped: "workbench.lifecycle.stopped",
  SessionNotFound: "workbench.session.not_found",
  ConfigurationInvalid: "workbench.session.configuration_invalid",
  RunActive: "workbench.session.run_active",
  SetupRefused: "workbench.session.setup_refused",
  AuthorizationRefused: "workbench.authorization.refused",
} as const;

export const workbenchConfigurationSchema = z.strictObject({
  agentProvider: z.string().min(1),
  modelIdentifier: z.string().min(1),
  reasoningEffort: reasoningEffortSchema,
});
export type WorkbenchConfiguration = z.infer<
  typeof workbenchConfigurationSchema
>;

const timestampSchema = z
  .number()
  .int()
  .describe("Unix epoch time in milliseconds.");

export const sessionEntrySchema = z.looseObject({
  type: z.string(),
  id: z.string(),
  parentId: z.string().nullable(),
  timestamp: z.string(),
});
export type SessionEntry = z.infer<typeof sessionEntrySchema>;

export const sessionListItemSchema = z.strictObject({
  id: z.string(),
  name: z.string().nullable(),
  created: timestampSchema,
  modified: timestampSchema,
  messageCount: z.number().int().nonnegative(),
  firstMessage: z.string(),
});

export const workbenchSessionSchema = z.strictObject({
  id: identitySchema(WORKBENCH_SESSION_PREFIX),
  agentName: z.string(),
  configuration: workbenchConfigurationSchema,
  entries: z.array(sessionEntrySchema),
  runActive: z.boolean(),
});
export type WorkbenchSession = z.infer<typeof workbenchSessionSchema>;

const emptyFields = z.strictObject({});
const sessionParams = z.strictObject({
  sessionId: identitySchema(WORKBENCH_SESSION_PREFIX),
});
const workbenchOperation = {
  service: WORKBENCH_SERVICE_NAME,
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  access: AccessPolicy.Human,
  timeoutMs: WORKBENCH_TIMEOUT_MS,
  status: HttpStatus.OK,
} as const;
const workbenchMutation = {
  ...workbenchOperation,
  mutation: true,
  body: true,
  maxBodyBytes: WORKBENCH_MAX_BODY_BYTES,
} as const;

export const workbenchOperations = {
  "session.list": {
    ...workbenchOperation,
    id: "workbench.session.list",
    method: HttpMethod.Get,
    path: "/api/workbench/session",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: emptyFields,
      query: z.strictObject({ agentName: z.string().min(1) }),
      body: z.null(),
    }),
    output: z.strictObject({ items: z.array(sessionListItemSchema) }),
    description: "List the workbench sessions of an agent.",
  },
  "session.create": {
    ...workbenchMutation,
    id: "workbench.session.create",
    method: HttpMethod.Post,
    path: "/api/workbench/session",
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: workbenchConfigurationSchema.extend({
        agentName: z.string().min(1),
      }),
    }),
    output: workbenchSessionSchema,
    description: "Create a workbench session with one agent of the catalog.",
  },
  "session.get": {
    ...workbenchOperation,
    id: "workbench.session.get",
    method: HttpMethod.Get,
    path: "/api/workbench/session/:sessionId",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: sessionParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: workbenchSessionSchema,
    description:
      "Get the configuration, the entries of the completed runs and the run state of a workbench session.",
  },
  "session.configure": {
    ...workbenchMutation,
    id: "workbench.session.configure",
    method: HttpMethod.Put,
    path: "/api/workbench/session/:sessionId/configuration",
    input: z.strictObject({
      params: sessionParams,
      query: emptyFields,
      body: workbenchConfigurationSchema,
    }),
    output: workbenchConfigurationSchema,
    description: "Replace the configuration of a workbench session.",
  },
} as const satisfies Record<string, Operation>;
