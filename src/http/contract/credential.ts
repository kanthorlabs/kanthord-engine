import { z } from "zod";

import { action, parameter, resource, sub } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
import { bindingInUseDetails } from "./error-details.ts";
import { EXAMPLE_AT as A, EXAMPLE_ULID as U } from "./example-literal.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";
import {
  providerKinds,
  providerProjection,
} from "../../domain/provider-payload.ts";

export const providerRegisterRequest = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(providerKinds),
  payload: z.unknown(),
});

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
export const providerSetDefaultResponse = providerView;
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
      password: "x",
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
  },
  error: {
    error: {
      code: "invalid-request",
      message: `provider provider_${U} of kind git cannot join the default chain`,
      details: { refusal: "kind-not-chainable" },
    },
  },
};

export const credential = operations([
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
    response: providerRemoveResponse,
    errors: { ...baselineErrors, "binding-in-use": bindingInUseDetails },
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
