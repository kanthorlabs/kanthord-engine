import { z } from "zod";

import { action, parameter, resource, sub } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import {
  EXAMPLE_AT as A,
  EXAMPLE_ULID as U,
  EXAMPLE_ULID_B as UB,
} from "./example-literal.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";
import {
  providerKinds,
  providerProjection,
  llmPayload,
  gitPayload,
} from "../../domain/provider-payload.ts";

const providerBindingInUseDetails = z.strictObject({
  blockers: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("default-chain") }),
        z.strictObject({
          kind: z.literal("project-binding"),
          projectId: z.string().min(1),
        }),
        z.strictObject({
          kind: z.literal("repository"),
          repositoryId: z.string().min(1),
        }),
        z.strictObject({
          kind: z.literal("attempt"),
          attemptId: z.string().min(1),
        }),
      ]),
    )
    .min(1),
});

export const providerRegisterRequest = z.discriminatedUnion("kind", [
  z.strictObject({
    name: z.string().min(1),
    kind: z.literal("llm"),
    payload: llmPayload,
  }),
  z.strictObject({
    name: z.string().min(1),
    kind: z.literal("git"),
    payload: gitPayload,
  }),
]);

export const providerView = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: z.enum(providerKinds),
  projection: providerProjection.nullable(),
  setDefaultAt: z.number().nullable(),
  updatedAt: z.number(),
});

export const providerRegisterResponse = providerView;
export const providerListResponse = z.strictObject({
  providers: z.array(providerView),
});
export const providerShowResponse = providerView;

export const providerRenameRequest = z.strictObject({
  name: z.string().min(1),
});
export const providerRenameResponse = providerView;
export const displacedProvider = z.strictObject({
  id: z.string(),
  name: z.string(),
});
export const providerSetDefaultResponse = providerView.extend({
  displaced: z.array(displacedProvider),
});
export const providerRemoveRequest = z.strictObject({
  force: z.enum(["true", "false"]).optional(),
});
export const providerRemoveResponse = z.strictObject({
  id: z.string(),
});

export const providerRegisterExamples: OperationExamples = {
  request: {
    name: "github",
    kind: "git",
    payload: {
      transport: "http-basic",
      forge: "github",
      username: "atlas",
      token: "x",
    },
  },
  success: {
    id: `provider_${U}`,
    name: "github",
    kind: "git",
    projection: { transport: "http-basic", forge: "github", username: "atlas" },
    setDefaultAt: null,
    updatedAt: A,
  },
  error: {
    error: {
      code: "invalid-request",
      message: "a provider named github is already registered",
      details: { refusal: "name-taken" },
    },
  },
};

export const providerListExamples: OperationExamples = {
  success: { providers: [providerRegisterExamples.success] },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const providerShowExamples: OperationExamples = {
  success: providerRegisterExamples.success,
  error: { error: { code: "not-found", message: `no provider provider_${U}` } },
};

export const providerRenameExamples: OperationExamples = {
  request: { name: "github-release" },
  success: {
    id: `provider_${U}`,
    name: "github-release",
    kind: "git",
    projection: { transport: "http-basic", forge: "github", username: "atlas" },
    setDefaultAt: null,
    updatedAt: A,
  },
  error: {
    error: {
      code: "invalid-request",
      message: "a provider named github-release is already registered",
      details: { refusal: "name-taken" },
    },
  },
};

export const providerRemoveExamples: OperationExamples = {
  query: { force: "false" },
  success: { id: `provider_${U}` },
  error: {
    error: {
      code: "binding-in-use",
      message: `provider provider_${U} is still in use`,
      details: {
        blockers: [
          { kind: "default-chain" },
          { kind: "project-binding", projectId: `project_${U}` },
          { kind: "repository", repositoryId: `repository_${U}` },
          { kind: "attempt", attemptId: `attempt_${U}` },
        ],
      },
    },
  },
};

export const providerSetDefaultExamples: OperationExamples = {
  success: {
    id: `provider_${U}`,
    name: "openai",
    kind: "llm",
    projection: { provider: "openai", defaultModel: "gpt-4o", baseUrl: null },
    setDefaultAt: A,
    updatedAt: A,
    displaced: [{ id: `provider_${UB}`, name: "anthropic" }],
  },
  error: {
    error: {
      code: "invalid-request",
      message: `provider provider_${U} of kind git cannot join the default chain`,
      details: { refusal: "kind-not-chainable" },
    },
  },
};

export const providerVerifyResponse = z.strictObject({
  checkedAt: z.number(),
  model: z.string(),
  reachability: z.enum(["reachable", "unreachable"]),
  authentication: z.enum(["accepted", "rejected", "unknown"]),
  completed: z.boolean(),
  refusal: z
    .enum([
      "endpoint-unreachable",
      "credential-rejected",
      "model-unavailable",
      "quota-exceeded",
      "endpoint-rejected",
    ])
    .nullable(),
  detail: z.string().optional(),
});

export const providerVerifyExamples: OperationExamples = {
  success: {
    checkedAt: A,
    model: "gpt-4o",
    reachability: "reachable",
    authentication: "accepted",
    completed: true,
    refusal: null,
  },
  error: {
    error: {
      code: "not-found",
      message: `no provider provider_${U}`,
    },
  },
};

const catalogModelCostRates = {
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
};

export const catalogModelCost = z.strictObject({
  ...catalogModelCostRates,
  tiers: z
    .array(
      z.strictObject({
        ...catalogModelCostRates,
        inputTokensAbove: z.number(),
      }),
    )
    .optional(),
});

export const catalogModel = z.strictObject({
  id: z.string(),
  name: z.string(),
  api: z.string(),
  provider: z.string(),
  baseUrl: z.string(),
  reasoning: z.boolean(),
  input: z.array(z.string()),
  cost: catalogModelCost,
  contextWindow: z.number(),
  maxTokens: z.number(),
});

export const catalogProvider = z.strictObject({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string().nullable(),
  requiresBaseUrl: z.boolean(),
  models: z.array(catalogModel),
});

export const providerCatalogRequest = z.strictObject({
  provider: z.string().min(1).optional(),
});

export const providerCatalogResponse = z.strictObject({
  providers: z.array(catalogProvider),
});

export const providerInspectRequest = z.strictObject({
  provider: z.string().min(1),
  baseUrl: z.string().min(1).nullable(),
  apiKey: z.string().min(1),
});

export const providerInspectResponse = z.strictObject({
  models: z.array(catalogModel),
});

const catalogModel_example = {
  id: "gpt-4o",
  name: "GPT-4o",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
};

export const providerCatalogExamples: OperationExamples = {
  query: { provider: "openai" },
  success: {
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        requiresBaseUrl: false,
        models: [catalogModel_example],
      },
      {
        id: "openai-compatible",
        name: "OpenAI Compatible API",
        baseUrl: null,
        requiresBaseUrl: true,
        models: [],
      },
    ],
  },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const providerInspectExamples: OperationExamples = {
  request: {
    provider: "openai-compatible",
    baseUrl: "http://inference.internal:8080/v1",
    apiKey: "x",
  },
  success: {
    models: [
      {
        id: "qwen3-30b",
        name: "qwen3-30b",
        api: "openai-completions",
        provider: "openai-compatible",
        baseUrl: "http://inference.internal:8080/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 0,
        maxTokens: 0,
      },
    ],
  },
  error: {
    error: {
      code: "invalid-request",
      message: "openai needs no baseUrl; read its models from provider.catalog",
      details: { refusal: "provider-not-inspectable" },
    },
  },
};

export const credential = operations([
  {
    operationId: "provider.catalog",
    method: "GET",
    path: [resource("provider"), sub("llm")],
    introducedIn: "phase-2",
    status: "routed",
    allowedActors: ["human"],
    query: providerCatalogRequest,
    response: providerCatalogResponse,
    errors: { ...baselineErrors },
    examples: providerCatalogExamples,
  },
  {
    operationId: "provider.inspect",
    method: "POST",
    path: [resource("provider"), action("inspect")],
    introducedIn: "phase-2",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    request: providerInspectRequest,
    response: providerInspectResponse,
    errors: { ...baselineErrors },
    examples: providerInspectExamples,
  },
  {
    operationId: "provider.register",
    method: "POST",
    path: [resource("provider")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    request: providerRegisterRequest,
    response: providerRegisterResponse,
    errors: { ...baselineErrors },
    examples: providerRegisterExamples,
  },
  {
    operationId: "provider.list",
    method: "GET",
    path: [resource("provider")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    response: providerListResponse,
    errors: { ...baselineErrors },
    examples: providerListExamples,
  },
  {
    operationId: "provider.show",
    method: "GET",
    path: [resource("provider"), parameter("provider")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    response: providerShowResponse,
    errors: { ...baselineErrors },
    examples: providerShowExamples,
  },
  {
    operationId: "provider.verify",
    method: "POST",
    path: [resource("provider"), parameter("provider"), action("verify")],
    introducedIn: "phase-1",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    response: providerVerifyResponse,
    errors: { ...baselineErrors },
    examples: providerVerifyExamples,
  },
  {
    operationId: "provider.rename",
    method: "POST",
    path: [resource("provider"), parameter("provider"), action("rename")],
    introducedIn: "phase-2",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    request: providerRenameRequest,
    response: providerRenameResponse,
    errors: { ...baselineErrors },
    examples: providerRenameExamples,
  },
  {
    operationId: "provider.remove",
    method: "DELETE",
    path: [resource("provider"), parameter("provider")],
    introducedIn: "phase-2",
    status: "routed",
    allowedActors: ["human"],
    query: providerRemoveRequest,
    response: providerRemoveResponse,
    errors: {
      ...baselineErrors,
      "binding-in-use": providerBindingInUseDetails,
    },
    examples: providerRemoveExamples,
  },
  {
    operationId: "provider.setDefault",
    method: "PUT",
    path: [resource("provider"), parameter("provider"), sub("default")],
    introducedIn: "phase-2",
    status: "routed",
    allowedActors: ["human"],
    response: providerSetDefaultResponse,
    errors: { ...baselineErrors },
    examples: providerSetDefaultExamples,
  },
]);
