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
  llmApiKeyPayload,
  llmOauthRegisterPayload,
  gitPayload,
} from "../../domain/provider-payload.ts";
import { identity } from "../../domain/identity.ts";

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

export const llmRegisterPayload = z.union([
  llmApiKeyPayload,
  llmOauthRegisterPayload,
]);

export const providerRegisterRequest = z.discriminatedUnion("kind", [
  z.strictObject({
    name: z.string().min(1),
    kind: z.literal("llm"),
    payload: llmRegisterPayload,
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
    projection: {
      transport: "api-key",
      provider: "openai",
      defaultModel: "gpt-4o",
      baseUrl: null,
    },
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

export const providerLoginStartRequest = z.strictObject({
  provider: z.string().min(1),
  answers: z.record(z.string(), z.string()).optional(),
});

export const providerLoginManualChallenge = z.strictObject({
  loginId: z.string(),
  method: z.literal("manual-code"),
  authUrl: z.string(),
  instructions: z.string(),
  expiresAt: z.number(),
});

export const providerLoginDeviceChallenge = z.strictObject({
  loginId: z.string(),
  method: z.literal("device-code"),
  userCode: z.string(),
  verificationUri: z.string(),
  expiresAt: z.number(),
  pollIntervalMs: z.number(),
});

export const providerLoginStartResponse = z.discriminatedUnion("method", [
  providerLoginManualChallenge,
  providerLoginDeviceChallenge,
]);

export const providerLoginCompleteRequest = z.strictObject({
  loginId: identity("providerLogin"),
  code: z.string().min(1).optional(),
});

export const providerLoginCompleteResponse = z.strictObject({
  loginId: z.string(),
  models: z.array(z.string()),
});

export const providerLoginCancelRequest = z.strictObject({
  loginId: identity("providerLogin"),
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

export const providerLoginStartExamples: OperationExamples = {
  request: { provider: "openai-codex" },
  success: {
    loginId: `login_${U}`,
    method: "device-code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://auth.example.test/device",
    expiresAt: A,
    pollIntervalMs: 5000,
  },
  error: {
    error: {
      code: "invalid-request",
      message: "the provider login method is unavailable",
      details: { refusal: "login-method-unavailable" },
    },
  },
};

export const providerLoginCompleteExamples: OperationExamples = {
  request: { loginId: `login_${U}`, code: "ABCD-EFGH" },
  success: { loginId: `login_${U}`, models: ["gpt-5-codex"] },
  error: {
    error: {
      code: "invalid-request",
      message: `login login_${U} is still pending`,
      details: { refusal: "login-pending" },
    },
  },
};

export const providerLoginCancelExamples = {
  request: { loginId: `login_${U}` },
  error: {
    error: { code: "not-found", message: `no login login_${U}` },
  },
} as OperationExamples;

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

export const catalogOauth = z.strictObject({ label: z.string() });

export const catalogProvider = z.strictObject({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string().nullable(),
  requiresBaseUrl: z.boolean(),
  oauth: catalogOauth.nullable(),
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
        oauth: null,
        models: [catalogModel_example],
      },
      {
        id: "openai-compatible",
        name: "OpenAI Compatible API",
        baseUrl: null,
        requiresBaseUrl: true,
        oauth: null,
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
    operationId: "provider.loginStart",
    method: "POST",
    path: [resource("provider"), sub("login")],
    introducedIn: "phase-2",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    request: providerLoginStartRequest,
    response: providerLoginStartResponse,
    errors: { ...baselineErrors },
    examples: providerLoginStartExamples,
  },
  {
    operationId: "provider.loginComplete",
    method: "POST",
    path: [resource("provider"), sub("login"), action("complete")],
    introducedIn: "phase-2",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [200],
    request: providerLoginCompleteRequest,
    response: providerLoginCompleteResponse,
    errors: { ...baselineErrors },
    examples: providerLoginCompleteExamples,
  },
  {
    operationId: "provider.loginCancel",
    method: "POST",
    path: [resource("provider"), sub("login"), action("cancel")],
    introducedIn: "phase-2",
    status: "routed",
    allowedActors: ["human"],
    idempotency: "memory",
    replayable: [204],
    successStatus: 204,
    request: providerLoginCancelRequest,
    errors: { ...baselineErrors },
    examples: providerLoginCancelExamples,
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
