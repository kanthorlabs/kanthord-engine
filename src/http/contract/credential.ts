import { z } from "zod";

import { action, parameter, resource, sub } from "./path.ts";
import { baselineErrors } from "./error-baseline.ts";
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

export const credential = operations([
  {
    operationId: "provider.register",
    method: "POST",
    path: [resource("provider")],
    introducedIn: "phase-1",
    status: "routed",
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
    response: providerShowResponse,
    errors: { ...baselineErrors },
    examples: providerShowExamples,
  },
  {
    operationId: "provider.rename",
    method: "POST",
    path: [resource("provider"), parameter("provider"), action("rename")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "provider.remove",
    method: "DELETE",
    path: [resource("provider"), parameter("provider")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
  {
    operationId: "provider.setDefault",
    method: "PUT",
    path: [resource("provider"), parameter("provider"), sub("default")],
    introducedIn: "phase-2",
    status: "stubbed",
  },
]);
